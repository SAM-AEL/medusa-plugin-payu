/**
 * PayU Payment Provider Service
 * MedusaJS 2 Payment Provider for PayU India
 * 
 * Implements redirect-based payment flow using official payu-websdk
 */

import {
    AbstractPaymentProvider,
    BigNumber,
    MedusaError,
    PaymentSessionStatus,
} from "@medusajs/framework/utils"
import type {
    InitiatePaymentInput,
    InitiatePaymentOutput,
    AuthorizePaymentInput,
    AuthorizePaymentOutput,
    CapturePaymentInput,
    CapturePaymentOutput,
    RefundPaymentInput,
    RefundPaymentOutput,
    CancelPaymentInput,
    CancelPaymentOutput,
    DeletePaymentInput,
    DeletePaymentOutput,
    GetPaymentStatusInput,
    GetPaymentStatusOutput,
    RetrievePaymentInput,
    RetrievePaymentOutput,
    UpdatePaymentInput,
    UpdatePaymentOutput,
    ProviderWebhookPayload,
    WebhookActionResult,
    Logger,
} from "@medusajs/framework/types"

import type { PayuProviderConfig, PayuSessionData, PayuWebhookPayload, PayuPaymentStatus } from "./types"
import { PayuClient, generateTxnId } from "./client"
import { sanitizeIndianPhone } from "./phone-utils"

export const PAYU_PROVIDER_ID = "payu"

/**
 * PayU Payment Provider Service
 * 
 * Flow:
 * 1. initiatePayment - Returns session data with payment URL and form data
 * 2. Frontend redirects customer to PayU checkout
 * 3. Customer completes payment on PayU
 * 4. PayU redirects back and sends webhook
 * 5. authorizePayment - Verifies and marks payment as authorized
 */
class PayuPaymentProviderService extends AbstractPaymentProvider<PayuProviderConfig> {
    static identifier = PAYU_PROVIDER_ID

    /**
     * Validate provider options at startup
     * Called by MedusaJS when registering the provider
     */
    static validateOptions(options: Record<string, unknown>): void {
        if (!options.merchantKey) {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                "PayU: merchantKey is required. Set PAYU_MERCHANT_KEY environment variable."
            )
        }
        if (!options.merchantSalt) {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                "PayU: merchantSalt is required. Set PAYU_MERCHANT_SALT environment variable."
            )
        }
    }

    protected config_: PayuProviderConfig
    protected logger_: Logger
    protected client_: PayuClient

    constructor(container: Record<string, unknown>, config: PayuProviderConfig) {
        super(container, config)

        if (!config.merchantKey || !config.merchantSalt) {
            throw new Error(
                "PayU: merchantKey and merchantSalt are required. " +
                "Set PAYU_MERCHANT_KEY and PAYU_MERCHANT_SALT environment variables."
            )
        }

        this.config_ = {
            merchantKey: config.merchantKey,
            merchantSalt: config.merchantSalt,
            environment: config.environment || "test",
            autoCapture: config.autoCapture ?? true,
        }

        this.logger_ = container.logger as Logger
        this.client_ = new PayuClient(this.config_, this.logger_)

        this.logger_?.info?.(`PayU initialized in ${this.config_.environment} mode`)
    }

    /**
     * Format amount to string with 2 decimals (PayU requirement)
     */
    private formatAmount(amount: any): string {
        let num: number
        if (typeof amount === "string") {
            num = parseFloat(amount)
        } else if (typeof amount === "number") {
            num = amount
        } else if (amount && typeof amount.toNumber === 'function') {
            // Handle BigNumber or custom objects
            num = amount.toNumber()
        } else if (amount && typeof amount === 'object' && 'value' in amount) {
            // Handle serialized BigNumber: { value: "155.82", precision: 20 }
            num = parseFloat(amount.value)
        } else {
            num = Number(amount)
        }
        return isNaN(num) ? "NaN" : num.toFixed(2)
    }

    /**
     * Initiate payment session
     */
    async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
        const { amount, context } = input

        try {
            const txnid = generateTxnId()
            const formattedAmount = this.formatAmount(amount)

            // Debug logging for amount calculation
            this.logger_?.info?.(`PayU initiatePayment - Raw amount: ${JSON.stringify(amount)}`)
            this.logger_?.info?.(`PayU initiatePayment - Formatted amount: ${formattedAmount}`)
            this.logger_?.info?.(`PayU initiatePayment - Context: ${JSON.stringify(context, null, 2)}`)

            const customer = context?.customer
            const inputData = input.data as Record<string, unknown> | undefined

            // CRITICAL: Medusa passes session_id via input.data.session_id
            // We must store this and pass it through PayU (via udf3) so webhooks
            // can return it to Medusa's processPaymentWorkflow
            const sessionId = (inputData?.session_id as string) || ""

            // Fallback chain: customer data -> input data (passed from frontend)
            // MedusaJS may not always populate the full customer context
            const email = customer?.email || (inputData?.email as string)
            if (!email) {
                throw new Error("Customer email is required for payment processing. Pass email in data payload or ensure customer is logged in.")
            }

            const firstname = customer?.first_name || (inputData?.firstname as string) || (inputData?.first_name as string)
            if (!firstname) {
                throw new Error("Customer name is required for payment processing. Pass firstname in data payload.")
            }

            // Fallback chain for phone: customer phone -> billing address phone -> shipping address phone -> input data
            // Then sanitize to 10-digit Indian format (strips +91, 91, 0091, 0 prefixes)
            const rawPhone = customer?.phone
                || customer?.billing_address?.phone
                || (inputData?.shipping_address_phone as string)
                || (inputData?.phone as string)

            const phone = sanitizeIndianPhone(rawPhone)
            if (!phone) {
                throw new Error(
                    "Valid phone number (at least 10 digits) is required for payment processing. " +
                    "Pass phone in data payload or ensure shipping/billing address has a valid phone."
                )
            }

            const productinfo = (inputData?.productinfo as string) || "Order Payment"

            // Extract cart_id and customer_id for UDF fields
            // These are passed through PayU and returned in webhook for traceability
            const cartId = (inputData?.cart_id as string) || ""
            const customerId = context?.customer?.id
                || (inputData?.customer_id as string)
                || ""

            this.logger_?.debug?.(`PayU initiatePayment - sessionId from Medusa: ${sessionId}`)

            // Build redirect URLs from environment variables
            // Allow NEXT_PUBLIC_BASE_URL as fallback for STOREFRONT_URL
            const storefrontUrl = process.env.STOREFRONT_URL || process.env.NEXT_PUBLIC_BASE_URL

            // Provide sensible defaults if specific paths aren't provided
            const redirectPath = process.env.PAYU_REDIRECT_URL || "/order/confirmed"
            const redirectFailurePath = process.env.PAYU_REDIRECT_FAILURE_URL || "/checkout"

            if (!storefrontUrl) {
                throw new Error("STOREFRONT_URL or NEXT_PUBLIC_BASE_URL environment variable is required")
            }

            const countryCode = (inputData?.country_code as string) || "in"

            // Constructs the URL: {base}/{country}/{path}
            // Ensure storefrontUrl doesn't have trailing slash and path starts with slash
            const cleanBase = storefrontUrl.replace(/\/$/, "")
            const cleanPath = redirectPath.startsWith("/") ? redirectPath : `/${redirectPath}`
            const cleanFailPath = redirectFailurePath.startsWith("/") ? redirectFailurePath : `/${redirectFailurePath}`

            const surl = `${cleanBase}/${countryCode}${cleanPath}`
            const furl = `${cleanBase}/${countryCode}${cleanFailPath}`

            // Generate hash using SDK (includes UDF fields)
            const hash = this.client_.generatePaymentHash({
                txnid,
                amount: formattedAmount,
                productinfo,
                firstname,
                email,
                udf1: cartId,
                udf2: customerId,
                udf3: sessionId,
                udf4: formattedAmount, // Store expected amount for webhook validation
            })

            const sessionData: PayuSessionData = {
                txnid,
                amount: formattedAmount,
                productinfo,
                firstname,
                email,
                phone,
                hash,
                paymentUrl: this.client_.getPaymentUrl(),
                status: "pending",
                countryCode,
                udf1: cartId,
                udf2: customerId,
                udf3: sessionId,
                udf4: formattedAmount,
            }

            this.logger_?.debug?.(`PayU payment initiated: ${txnid}`)

            return {
                id: txnid,
                data: {
                    ...sessionData,
                    form_data: {
                        key: this.config_.merchantKey,
                        txnid,
                        amount: formattedAmount,
                        productinfo,
                        firstname,
                        email,
                        phone,
                        surl,
                        furl,
                        hash,
                        udf1: cartId,
                        udf2: customerId,
                        udf3: sessionId,
                        udf4: formattedAmount,
                        service_provider: "payu_paisa",
                    },
                } as unknown as Record<string, unknown>,
            }
        } catch (error) {
            this.logger_?.error?.(`PayU initiatePayment error: ${error}`)
            throw error
        }
    }

    /**
     * Authorize payment after PayU callback
     */
    async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
        try {
            const sessionData = input.data as unknown as PayuSessionData

            if (sessionData.status === "authorized" || sessionData.status === "captured") {
                return {
                    status: PaymentSessionStatus.AUTHORIZED,
                    data: input.data,
                }
            }

            const response = await this.client_.verifyPayment(sessionData.txnid)

            if (response.status === 1) {
                const txn = response.transaction_details[sessionData.txnid]
                if (txn?.status === "success") {
                    this.logger_?.info?.(`PayU authorized/captured: ${sessionData.txnid}, mode=${txn.mode}`)

                    // If autoCapture is enabled, return CAPTURED status
                    const status = this.config_.autoCapture ? PaymentSessionStatus.CAPTURED : PaymentSessionStatus.AUTHORIZED

                    return {
                        status,
                        data: {
                            ...sessionData,
                            status: this.config_.autoCapture ? ("captured" as PayuPaymentStatus) : ("authorized" as PayuPaymentStatus),
                            payuTransactionId: txn.mihpayid,
                            paymentMode: txn.mode || "Online",
                            bankRefNum: txn.bank_ref_num || txn.bank_ref_num || "",
                            payuResponse: txn,
                        } as unknown as Record<string, unknown>,
                    }
                }
            }

            return {
                status: PaymentSessionStatus.ERROR,
                data: { ...sessionData, status: "failed" as PayuPaymentStatus },
            }
        } catch (error) {
            this.logger_?.error?.(`PayU authorizePayment error: ${error}`)
            throw error
        }
    }

    /**
     * Capture payment (PayU auto-captures)
     */
    async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
        const sessionData = input.data as unknown as PayuSessionData
        return {
            data: { ...sessionData, status: "captured" as PayuPaymentStatus } as unknown as Record<string, unknown>,
        }
    }

    /**
     * Refund payment
     */
    async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
        try {
            this.logger_?.info?.(`PayU refund input: ${JSON.stringify(input)}`)

            const sessionData = input.data as unknown as PayuSessionData

            if (!sessionData.payuTransactionId) {
                throw new Error(
                    "No PayU transaction ID (mihpayid) found. " +
                    "This payment may not have been fully captured or the session data is incomplete."
                )
            }

            // Create a deterministic substring of the transaction ID to avoid token length >30 chars errors in PayU
            // Use txnid or fallback to mihpayid, keeping just the last 10 characters and add current day date
            const safeTxnidHash = (sessionData.txnid || sessionData.payuTransactionId).slice(-10)
            const todayStr = new Date().toISOString().split('T')[0].replace(/-/g, '')
            // e.g. REF_a1b2c3d4e5_20231024
            const tokenId = `REF_${safeTxnidHash}_${todayStr}`
            const refundAmount = this.formatAmount(input.amount)

            if (!refundAmount || refundAmount === "NaN") {
                throw new MedusaError(
                    MedusaError.Types.INVALID_DATA,
                    `Invalid refund amount: ${input.amount}`
                )
            }

            this.logger_?.info?.(
                `PayU refund request: mihpayid=${sessionData.payuTransactionId}, ` +
                `txnid=${sessionData.txnid}, amount=${refundAmount}, tokenId=${tokenId}`
            )

            const response = await this.client_.refund(
                sessionData.payuTransactionId,
                tokenId,
                refundAmount
            )

            // Log full PayU response for debugging
            this.logger_?.info?.(
                `PayU refund response: status=${response.status}, msg=${response.msg}, ` +
                `request_id=${response.request_id || 'N/A'}, mihpayid=${response.mihpayid || 'N/A'}, ` +
                `error_code=${response.error_code || 'N/A'}, full=${JSON.stringify(response)}`
            )

            if (response.status === 1) {
                // Check for same-day capture message (treated as pending success)
                if (response.msg?.includes?.("Capture is done today")) {
                    this.logger_?.info?.(
                        `PayU refund queued for ${sessionData.txnid}: Same-day capture, ` +
                        `refund will be processed tomorrow. request_id=${response.request_id}`
                    )
                }

                this.logger_?.info?.(`PayU refund successful: ${sessionData.txnid}, request_id=${response.request_id}`)
                return {
                    data: {
                        ...sessionData,
                        status: "refunded" as PayuPaymentStatus,
                        refund: {
                            tokenId,
                            amount: refundAmount,
                            request_id: response.request_id,
                            response
                        },
                    } as unknown as Record<string, unknown>,
                }
            }

            // Handle specific refund failure scenarios
            let errorMessage = response.msg || "Unknown error"

            // Common PayU refund errors with helpful messages
            if (response.msg?.toLowerCase?.().includes?.("try after some time")) {
                errorMessage =
                    `PayU says: "${response.msg}". ` +
                    `This usually means: ` +
                    `(1) The payment was captured today and PayU requires 24 hours before refund, ` +
                    `(2) A refund is already in progress for this transaction, or ` +
                    `(3) PayU is experiencing temporary issues. Please try again later.`
            } else if (response.msg?.toLowerCase?.().includes?.("token already used")) {
                errorMessage =
                    `Refund token already used. A refund may already be pending for this transaction. ` +
                    `Please check the transaction status in PayU dashboard.`
            } else if (response.msg?.toLowerCase?.().includes?.("transaction not exists")) {
                errorMessage =
                    `Transaction not found in PayU. The mihpayid (${sessionData.payuTransactionId}) may be incorrect.`
            } else if (response.msg?.toLowerCase?.().includes?.("amount")) {
                errorMessage =
                    `Invalid refund amount (${refundAmount}). Please ensure it doesn't exceed the original transaction amount.`
            }

            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                `Refund failed: ${errorMessage}`
            )
        } catch (error) {
            this.logger_?.error?.(`PayU refundPayment error: ${error}`)
            // Re-throw MedusaErrors as-is so message is preserved
            if (error instanceof MedusaError) {
                throw error
            }
            // Wrap unexpected errors with context
            throw new MedusaError(
                MedusaError.Types.UNEXPECTED_STATE,
                error instanceof Error ? error.message : String(error)
            )
        }
    }

    /**
     * Cancel payment
     */
    async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
        const sessionData = input.data as unknown as PayuSessionData
        return {
            data: { ...sessionData, status: "cancelled" as PayuPaymentStatus } as unknown as Record<string, unknown>,
        }
    }

    /**
     * Delete payment session
     */
    async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
        return { data: input.data }
    }

    /**
     * Get payment status
     */
    async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
        const sessionData = input.data as unknown as PayuSessionData

        const statusMap: Record<PayuPaymentStatus, PaymentSessionStatus> = {
            pending: PaymentSessionStatus.PENDING,
            authorized: PaymentSessionStatus.AUTHORIZED,
            captured: PaymentSessionStatus.CAPTURED,
            failed: PaymentSessionStatus.ERROR,
            refunded: PaymentSessionStatus.AUTHORIZED,
            cancelled: PaymentSessionStatus.CANCELED,
        }

        return { status: statusMap[sessionData.status] || PaymentSessionStatus.PENDING }
    }

    /**
     * Retrieve payment details
     */
    async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
        return { data: input.data }
    }

    /**
     * Update payment session
     * 
     * IMPORTANT: Always generates a fresh txnid because PayU doesn't allow
     * reusing transaction IDs - even for failed payments. This ensures
     * retry scenarios work correctly.
     */
    async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
        try {
            const { data, amount } = input
            const sessionData = data as unknown as PayuSessionData

            // ALWAYS generate a fresh txnid for PayU
            // PayU doesn't allow reusing txnids, even for failed payments
            const newTxnid = generateTxnId()

            this.logger_?.info?.(`PayU updatePayment: Generating fresh txnid ${newTxnid} (replacing ${sessionData.txnid})`)

            const formattedAmount = amount ? this.formatAmount(amount) : sessionData.amount

            // Build redirect URLs from environment variables
            // Allow NEXT_PUBLIC_BASE_URL as fallback for STOREFRONT_URL
            const storefrontUrl = process.env.STOREFRONT_URL || process.env.NEXT_PUBLIC_BASE_URL

            // Provide sensible defaults if specific paths aren't provided
            const redirectPath = process.env.PAYU_REDIRECT_URL || "/order/confirmed"
            const redirectFailurePath = process.env.PAYU_REDIRECT_FAILURE_URL || "/checkout"

            if (!storefrontUrl) {
                throw new Error("STOREFRONT_URL or NEXT_PUBLIC_BASE_URL environment variable is required")
            }

            // Constructs the URL: {base}/{country}/{path}
            // Ensure storefrontUrl doesn't have trailing slash and path starts with slash
            const cleanBase = storefrontUrl.replace(/\/$/, "")
            const cleanPath = redirectPath.startsWith("/") ? redirectPath : `/${redirectPath}`
            const cleanFailPath = redirectFailurePath.startsWith("/") ? redirectFailurePath : `/${redirectFailurePath}`

            // Generate new hash with the fresh txnid
            const hash = this.client_.generatePaymentHash({
                txnid: newTxnid,
                amount: formattedAmount,
                productinfo: sessionData.productinfo,
                firstname: sessionData.firstname,
                email: sessionData.email,
                udf1: sessionData.udf1,
                udf2: sessionData.udf2,
                udf3: sessionData.udf3,
                udf4: formattedAmount,
            })

            const surl = `${cleanBase}/${sessionData.countryCode || 'in'}${cleanPath}`
            const furl = `${cleanBase}/${sessionData.countryCode || 'in'}${cleanFailPath}`

            return {
                data: {
                    ...sessionData,
                    txnid: newTxnid,  // Replace with fresh txnid
                    amount: formattedAmount,
                    hash,
                    form_data: {
                        key: this.config_.merchantKey,
                        txnid: newTxnid,  // Use fresh txnid
                        amount: formattedAmount,
                        productinfo: sessionData.productinfo,
                        firstname: sessionData.firstname,
                        email: sessionData.email,
                        phone: sessionData.phone,
                        surl,
                        furl,
                        hash,
                        udf1: sessionData.udf1,
                        udf2: sessionData.udf2,
                        udf3: sessionData.udf3,
                        udf4: formattedAmount,
                        service_provider: "payu_paisa",
                    },
                } as unknown as Record<string, unknown>,
            }
        } catch (error) {
            this.logger_?.error?.(`PayU updatePayment error: ${error}`)
            throw error
        }
    }

    /**
     * Handle webhook from PayU
     * 
     * PayU sends webhooks for payment status updates.
     * Webhook URL format: https://your-backend.com/hooks/payment/payu_payu
     * 
     * The webhook payload is URL-encoded form data with fields matching PayuWebhookPayload.
     * Hash verification ensures the webhook is authentic and hasn't been tampered with.
     */
    async getWebhookActionAndData(data: ProviderWebhookPayload["payload"]): Promise<WebhookActionResult> {
        try {
            this.logger_?.info?.(
                `[PayU Webhook] payload check: data keys=${data ? Object.keys(data).join(',') : 'null'} | ` +
                `nested=${data?.data ? Object.keys(data.data as object).join(',') : 'null'}`
            )

            // INTERCEPT EXPRESS/MEDUSA MIS-PARSED JSON STRINGS
            // recover express body parser oopsies 
            const extractJson = (payload: any) => {
                if (payload && typeof payload === 'object' && !Buffer.isBuffer(payload)) {
                    const keys = Object.keys(payload);
                    if (keys.length === 1 && typeof keys[0] === 'string' && keys[0].trim().startsWith('{') && keys[0].trim().endsWith('}')) {
                        try {
                            return JSON.parse(keys[0]);
                        } catch (e) { /* ignore */ }
                    }
                }
                return payload;
            };

            let resolvedData = extractJson(data);
            if (resolvedData?.data) {
                resolvedData.data = extractJson(resolvedData.data);
            }
            if ((resolvedData as Record<string, unknown>)?.rawData && !Buffer.isBuffer((resolvedData as any).rawData) && typeof (resolvedData as any).rawData === 'object') {
                (resolvedData as any).rawData = extractJson((resolvedData as any).rawData);
            }

            // unwrap PayU new payload structure
            if (resolvedData?.event_payload && typeof resolvedData.event_payload === 'object') {
                resolvedData = resolvedData.event_payload;
            } else if (resolvedData?.data?.event_payload && typeof resolvedData.data.event_payload === 'object') {
                resolvedData.data = resolvedData.data.event_payload;
            } else if ((resolvedData as any)?.rawData?.event_payload && typeof (resolvedData as any).rawData.event_payload === 'object') {
                (resolvedData as any).rawData = (resolvedData as any).rawData.event_payload;
            }

            // PayU webhooks can send JSON or form-urlencoded data
            // Medusa provides both parsed `data` and `rawData` (Buffer/string)
            // Priority: parsed data.data > rawData > direct properties
            let webhook: PayuWebhookPayload

            // 1. Check if data.data contains the webhook fields (Medusa already parsed the body)
            if (resolvedData?.data && typeof resolvedData.data === 'object' && !Buffer.isBuffer(resolvedData.data)) {
                const dataObj = resolvedData.data as Record<string, unknown>
                // map alternative key names if missing
                if (dataObj.merchantTransactionId && !dataObj.txnid) dataObj.txnid = dataObj.merchantTransactionId
                if (dataObj.paymentId && !dataObj.mihpayid) dataObj.mihpayid = dataObj.paymentId
                if (dataObj.customerEmail && !dataObj.email) dataObj.email = dataObj.customerEmail
                if (dataObj.customerName && !dataObj.firstname) dataObj.firstname = dataObj.customerName
                if (dataObj.customerPhone && !dataObj.phone) dataObj.phone = dataObj.customerPhone
                if (dataObj.productInfo && !dataObj.productinfo) dataObj.productinfo = dataObj.productInfo

                if (dataObj.txnid || dataObj.status) {
                    webhook = dataObj as unknown as PayuWebhookPayload
                    this.logger_?.debug?.(`PayU webhook: Extracted from data.data, txnid=${webhook.txnid}`)
                } else {
                    this.logger_?.warn?.(`[PayU Webhook] data.data missing txnid/status: keys=${Object.keys(dataObj).join(',')}`)
                    webhook = dataObj as unknown as PayuWebhookPayload
                }
            }
            // 2. Fallback to rawData (Buffer/string) — try JSON first, then URL-encoded
            else if ((resolvedData as Record<string, unknown>)?.rawData) {
                const rawData = (resolvedData as Record<string, unknown>).rawData
                this.logger_?.debug?.(`PayU webhook: Using rawData fallback, type=${typeof rawData}`)

                if (typeof rawData === 'string' || Buffer.isBuffer(rawData)) {
                    const bodyStr = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : rawData
                    const trimmed = bodyStr.trim()

                    // Try JSON first (PayU's newer webhook format)
                    if (trimmed.startsWith('{')) {
                        try {
                            let parsed = JSON.parse(trimmed)
                            // Unwrap event_payload if present
                            if (parsed.event_payload && typeof parsed.event_payload === 'object') {
                                parsed = parsed.event_payload
                            }
                            webhook = parsed as PayuWebhookPayload
                            this.logger_?.debug?.(`PayU webhook: Parsed rawData as JSON, txnid=${webhook.txnid}`)
                        } catch (e) {
                            // JSON parse failed, fall through to URL-encoded
                            const params = new URLSearchParams(bodyStr)
                            webhook = Object.fromEntries(params.entries()) as unknown as PayuWebhookPayload
                            this.logger_?.debug?.(`PayU webhook: Parsed rawData as URL-encoded, txnid=${webhook.txnid}`)
                        }
                    } else {
                        // URL-encoded form data (PayU's legacy format)
                        const params = new URLSearchParams(bodyStr)
                        webhook = Object.fromEntries(params.entries()) as unknown as PayuWebhookPayload
                        this.logger_?.debug?.(`PayU webhook: Parsed rawData as URL-encoded, txnid=${webhook.txnid}`)
                    }
                } else {
                    webhook = rawData as unknown as PayuWebhookPayload
                }
            }
            // 3. Check direct properties on resolvedData
            else if ((resolvedData as Record<string, unknown>)?.txnid || (resolvedData as Record<string, unknown>)?.status || (resolvedData as Record<string, unknown>)?.merchantTransactionId) {
                const dataObj = resolvedData as Record<string, unknown>
                if (dataObj.merchantTransactionId && !dataObj.txnid) dataObj.txnid = dataObj.merchantTransactionId
                if (dataObj.paymentId && !dataObj.mihpayid) dataObj.mihpayid = dataObj.paymentId
                if (dataObj.customerEmail && !dataObj.email) dataObj.email = dataObj.customerEmail
                if (dataObj.customerName && !dataObj.firstname) dataObj.firstname = dataObj.customerName
                if (dataObj.customerPhone && !dataObj.phone) dataObj.phone = dataObj.customerPhone
                if (dataObj.productInfo && !dataObj.productinfo) dataObj.productinfo = dataObj.productInfo

                webhook = dataObj as unknown as PayuWebhookPayload
            } else {
                this.logger_?.error?.(`[PayU Webhook] unreadable payload: ${JSON.stringify(resolvedData)?.substring(0, 500)}`)
                return { action: "not_supported" }
            }

            if (!webhook.txnid || !webhook.status || !webhook.hash) {
                this.logger_?.error?.(`[PayU Webhook] missing required fields - txnid:${webhook.txnid}, status:${webhook.status}, hash:${webhook.hash ? 'yes' : 'no'}`)
                return { action: "not_supported" }
            }

            this.logger_?.info?.(
                `[PayU Webhook] txnid=${webhook.txnid}, status=${webhook.status}, amount=${webhook.amount}`
            )

            // Verify hash to ensure webhook authenticity
            // Formula: sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
            const isValid = this.client_.verifyResponseHash({
                status: webhook.status,
                email: webhook.email,
                firstname: webhook.firstname,
                productinfo: webhook.productinfo,
                amount: webhook.amount,
                txnid: webhook.txnid,
                hash: webhook.hash,
                udf1: webhook.udf1,
                udf2: webhook.udf2,
                udf3: webhook.udf3,
                udf4: webhook.udf4,
                udf5: webhook.udf5,
            })

            if (!isValid) {
                this.logger_?.warn?.(
                    `PayU webhook: Hash verification FAILED for txnid=${webhook.txnid}. ` +
                    `This could indicate a tampered webhook or configuration mismatch.`
                )
                return { action: "not_supported" }
            }

            this.logger_?.debug?.(`PayU webhook: Hash verified successfully for txnid=${webhook.txnid}`)

            // Session ID is the Medusa payment session ID, stored in udf3 during initiatePayment
            // This is required for Medusa's processPaymentWorkflow to find the payment session
            const sessionId = webhook.udf3 || webhook.txnid
            const status = webhook.status.toLowerCase()

            // Map statuses for faster switch-case matching
            const statusMap: Record<string, string> = {
                "success": "success",
                "failure": "failed",
                "failed": "failed",
                "refund": "refund",
                "refunded": "refund",
                "dispute": "dispute",
                "chargeback": "dispute",
            }
            const normalizedStatus = statusMap[status] || status

            switch (normalizedStatus) {
                case "success":
                    this.logger_?.info?.(`PayU webhook: Payment SUCCESS for txnid=${webhook.txnid}, processing session ${sessionId}`)

                    // Security check: Compare paid amount with expected amount (stored in udf4)
                    const paidAmount = parseFloat(webhook.amount)
                    const expectedAmount = parseFloat(webhook.udf4 || "0")

                    if (!isNaN(expectedAmount) && expectedAmount > 0 && paidAmount < expectedAmount) {
                        this.logger_?.warn?.(
                            `[PayU Webhook] Amount discrepancy detected for txnid=${webhook.txnid}. ` +
                            `Expected: ${expectedAmount}, Paid: ${paidAmount}. Marking as requires_more.`
                        )
                        return {
                            action: "requires_more",
                            data: {
                                session_id: sessionId,
                                amount: new BigNumber(paidAmount),
                            },
                        }
                    }

                    return {
                        action: this.config_.autoCapture ? "captured" : "authorized",
                        data: {
                            session_id: sessionId,
                            amount: new BigNumber(paidAmount),
                        },
                    }
                case "failed":
                    this.logger_?.info?.(
                        `PayU webhook: Payment FAILED for txnid=${webhook.txnid}, ` +
                        `error=${webhook.error || 'N/A'}, error_Message=${webhook.error_Message || 'N/A'}`
                    )
                    return {
                        action: "failed",
                        data: {
                            session_id: sessionId,
                            amount: new BigNumber(parseFloat(webhook.amount)),
                        },
                    }
                case "refund":
                    this.logger_?.info?.(
                        `PayU webhook: REFUND processed for txnid=${webhook.txnid}, ` +
                        `mihpayid=${webhook.mihpayid || 'N/A'}, amount=${webhook.amount}`
                    )
                    return { action: "not_supported" }
                case "dispute":
                    this.logger_?.warn?.(
                        `PayU webhook: ⚠️ DISPUTE/CHARGEBACK received for txnid=${webhook.txnid}, ` +
                        `mihpayid=${webhook.mihpayid || 'N/A'}, amount=${webhook.amount}. ` +
                        `Manual review required!`
                    )
                    return { action: "not_supported" }
                default:
                    this.logger_?.info?.(`PayU webhook: Unhandled status '${webhook.status}' for txnid=${webhook.txnid}`)
                    return { action: "not_supported" }
            }
        } catch (error) {
            this.logger_?.error?.(
                `PayU webhook processing error: ${error instanceof Error ? error.message : String(error)}`
            )
            return { action: "not_supported" }
        }
    }
}

export default PayuPaymentProviderService
