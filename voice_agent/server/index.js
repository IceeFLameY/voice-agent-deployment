/*
 * Minimal Auth Server for Demo (Express + JWT)
 * - Provides real login endpoint backed by environment-configured super admin credentials
 * - Endpoints:
 *   POST /api/auth/login { username, password } -> { token, user }
 *   GET  /api/auth/me (Authorization: Bearer <token>) -> { user }
 *   POST /api/auth/logout -> { ok: true }
 *
 * SECURITY NOTES:
 * - Credentials are read from environment variables: SUPERADMIN_USER, SUPERADMIN_PASS
 * - JWT is signed with JWT_SECRET
 * - For demo convenience, defaults are provided if env is missing. Change them in your local env.
 */

import express from 'express'
import cors from 'cors'
import jwt from 'jsonwebtoken'
import nodemailer from 'nodemailer'
import twilio from 'twilio'
import WechatPayPkg from 'wechatpay-axios-plugin'
const { WechatPay } = WechatPayPkg || {}
import * as AlipaySdkPkg from 'alipay-sdk'
// import AlipayFormData from 'alipay-sdk/lib/form' // disabled to avoid ESM subpath exports error in dev
import crypto from 'crypto'

const PORT = process.env.AUTH_SERVER_PORT || 8787
const JWT_SECRET = process.env.JWT_SECRET || 'dev_jwt_secret_change_me'
// Demo defaults – please override with env vars in local development
const SUPERADMIN_USER = process.env.SUPERADMIN_USER || 'superadmin'
const SUPERADMIN_PASS = process.env.SUPERADMIN_PASS || 'Super@12345'

// Email SMTP config (use Mailtrap, Gmail App Password, or your SMTP)
const SMTP_HOST = process.env.SMTP_HOST || ''
const SMTP_PORT = Number(process.env.SMTP_PORT || 587)
const SMTP_SECURE = (process.env.SMTP_SECURE || 'false') === 'true'
const SMTP_USER = process.env.SMTP_USER || ''
const SMTP_PASS = process.env.SMTP_PASS || ''
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER || 'no-reply@example.com'

// Twilio SMS config (or adapt to your SMS provider)
const TWILIO_SID = process.env.TWILIO_SID || ''
const TWILIO_TOKEN = process.env.TWILIO_TOKEN || ''
const TWILIO_FROM = process.env.TWILIO_FROM || ''

// WeChat Pay config
const WECHAT_APP_ID = process.env.WECHAT_APP_ID || ''
const WECHAT_MCH_ID = process.env.WECHAT_MCH_ID || ''
const WECHAT_API_V3_KEY = process.env.WECHAT_API_V3_KEY || ''
const WECHAT_PRIVATE_KEY = process.env.WECHAT_PRIVATE_KEY || ''
const WECHAT_SERIAL_NO = process.env.WECHAT_SERIAL_NO || ''
const WECHAT_NOTIFY_URL = process.env.WECHAT_NOTIFY_URL || 'http://localhost:8787/api/payment/notify/wechat'

// Alipay config
const ALIPAY_APP_ID = process.env.ALIPAY_APP_ID || ''
const ALIPAY_PRIVATE_KEY = process.env.ALIPAY_PRIVATE_KEY || ''
const ALIPAY_PUBLIC_KEY = process.env.ALIPAY_PUBLIC_KEY || ''
const ALIPAY_GATEWAY = process.env.ALIPAY_GATEWAY || 'https://openapi.alipay.com/gateway.do'
const ALIPAY_NOTIFY_URL = process.env.ALIPAY_NOTIFY_URL || 'http://localhost:8787/api/payment/notify/alipay'

const app = express()
app.use(cors())
app.use(express.json())

/**
 * Issue JWT token for given payload
 */
function signToken(payload, opts = {}) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d', ...opts })
}

/**
 * Middleware to extract user from Authorization header
 */
function authMiddleware(req, res, next) {
  const auth = req.headers['authorization'] || ''
  const m = auth.match(/^Bearer\s+(.+)$/i)
  if (!m) return res.status(401).json({ error: 'Unauthorized' })
  try {
    const token = m[1]
    const decoded = jwt.verify(token, JWT_SECRET)
    req.user = decoded
    next()
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' })
  }
}

/**
 * In-memory OTP store and simple rate limiting bucket
 * - Structure: key -> { code, expireAt, lastSentAt, sendCount }
 * - key is either email or phone
 */
const otpStore = new Map()
const OTP_TTL_MS = 5 * 60 * 1000 // 5 minutes
const OTP_RESEND_WINDOW_MS = 60 * 1000 // allow resend after 60s
const OTP_DAILY_LIMIT = 10

/**
 * Helper: generate 6-digit numeric OTP
 */
function genOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

/**
 * Helper: parse target to determine if it's email or phone
 */
function parseTarget(target) {
  if (target.includes('@')) return { type: 'email', value: target }
  // Simple phone check (digits, +, -, spaces)
  if (/^[\d\s\+\-]+$/.test(target)) return { type: 'phone', value: target }
  throw new Error('Invalid target format')
}

/**
 * Send OTP via email
 */
async function sendOtpEmail(to, code) {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log(`[dev] Would send email OTP ${code} to ${to}`)
    return
  }
  const transporter = nodemailer.createTransporter({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  })
  await transporter.sendMail({
    from: MAIL_FROM,
    to,
    subject: 'Your verification code',
    text: `Your verification code is: ${code}. Valid for 5 minutes.`
  })
}

/**
 * Send OTP via SMS
 */
async function sendOtpSms(to, code) {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
    console.log(`[dev] Would send SMS OTP ${code} to ${to}`)
    return
  }
  const client = twilio(TWILIO_SID, TWILIO_TOKEN)
  await client.messages.create({
    body: `Your verification code is: ${code}. Valid for 5 minutes.`,
    from: TWILIO_FROM,
    to
  })
}

/**
 * POST /api/auth/send-otp
 * Body: { target } where target is email or phone
 */
app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { target } = req.body
    if (!target) return res.status(400).json({ error: 'Target required' })
    
    const parsed = parseTarget(target)
    const now = Date.now()
    const existing = otpStore.get(target)
    
    // Rate limiting
    if (existing) {
      if (existing.sendCount >= OTP_DAILY_LIMIT) {
        return res.status(429).json({ error: 'Daily limit exceeded' })
      }
      if (now - existing.lastSentAt < OTP_RESEND_WINDOW_MS) {
        return res.status(429).json({ error: 'Please wait before requesting again' })
      }
    }
    
    const code = genOtp()
    const expireAt = now + OTP_TTL_MS
    
    // Send OTP
    if (parsed.type === 'email') {
      await sendOtpEmail(target, code)
    } else {
      await sendOtpSms(target, code)
    }
    
    // Store OTP
    otpStore.set(target, {
      code,
      expireAt,
      lastSentAt: now,
      sendCount: (existing?.sendCount || 0) + 1
    })
    
    res.json({ success: true, message: 'OTP sent' })
  } catch (e) {
    console.error('Send OTP error:', e)
    res.status(500).json({ error: 'Failed to send OTP' })
  }
})

/**
 * POST /api/auth/verify-otp
 * Body: { target, code }
 */
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { target, code } = req.body
    if (!target || !code) return res.status(400).json({ error: 'Target and code required' })
    
    const stored = otpStore.get(target)
    if (!stored) return res.status(400).json({ error: 'No OTP found' })
    
    if (Date.now() > stored.expireAt) {
      otpStore.delete(target)
      return res.status(400).json({ error: 'OTP expired' })
    }
    
    if (stored.code !== code) {
      return res.status(400).json({ error: 'Invalid OTP' })
    }
    
    // OTP verified, clean up and issue token
    otpStore.delete(target)
    const user = { id: target, username: target, role: 'user' }
    const token = signToken(user)
    
    res.json({ token, user })
  } catch (e) {
    console.error('Verify OTP error:', e)
    res.status(500).json({ error: 'Failed to verify OTP' })
  }
})

/**
 * POST /api/auth/login
 * Body: { username, password }
 */
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body
  if (username === SUPERADMIN_USER && password === SUPERADMIN_PASS) {
    const user = { id: 'superadmin', username: SUPERADMIN_USER, role: 'admin' }
    const token = signToken(user)
    res.json({ token, user })
  } else {
    res.status(401).json({ error: 'Invalid credentials' })
  }
})

/**
 * GET /api/auth/me
 */
app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user })
})

/**
 * POST /api/auth/logout
 */
app.post('/api/auth/logout', (_req, res) => {
  res.json({ ok: true })
})

// Payment integration setup
let wechatPay = null
let alipaySdk = null

// Initialize WeChat Pay
if (WECHAT_APP_ID && WECHAT_MCH_ID && WECHAT_API_V3_KEY && WECHAT_PRIVATE_KEY && WECHAT_SERIAL_NO && WechatPay) {
  try {
    wechatPay = WechatPay({
      appid: WECHAT_APP_ID,
      mchid: WECHAT_MCH_ID,
      publicKey: Buffer.from(WECHAT_PRIVATE_KEY, 'utf8'),
      privateKey: Buffer.from(WECHAT_PRIVATE_KEY, 'utf8'),
      key: WECHAT_API_V3_KEY,
      serial: WECHAT_SERIAL_NO
    })
    console.log('[payment] WeChat Pay initialized')
  } catch (e) {
    console.error('[payment] WeChat Pay init failed:', e.message)
  }
} else {
  console.log('[payment] WeChat Pay not configured, using development mode')
}

// Initialize Alipay
if (ALIPAY_APP_ID && ALIPAY_PRIVATE_KEY && ALIPAY_PUBLIC_KEY) {
  try {
    alipaySdk = new AlipaySdkPkg.default({
      appId: ALIPAY_APP_ID,
      privateKey: ALIPAY_PRIVATE_KEY,
      alipayPublicKey: ALIPAY_PUBLIC_KEY,
      gateway: ALIPAY_GATEWAY,
      timeout: 5000,
      camelCase: true
    })
    console.log('[payment] Alipay SDK initialized')
  } catch (e) {
    console.error('[payment] Alipay SDK init failed:', e.message)
  }
} else {
  console.log('[payment] Alipay not configured, using development mode')
}

// In-memory order store (use database in production)
const orderStore = new Map()

/**
 * Create payment order
 * POST /api/payment/create-order
 * Body: { amount, currency, description, paymentMethod }
 */
app.post('/api/payment/create-order', authMiddleware, async (req, res) => {
  try {
    const { amount, currency = 'CNY', description, paymentMethod } = req.body
    
    if (!amount || !paymentMethod) {
      return res.status(400).json({ error: 'Amount and payment method required' })
    }
    
    const orderId = crypto.randomUUID()
    const order = {
      id: orderId,
      userId: req.user.id,
      amount: parseFloat(amount),
      currency,
      description: description || 'Payment',
      paymentMethod,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    
    orderStore.set(orderId, order)
    
    let paymentData = null
    
    if (paymentMethod === 'wechat') {
      if (wechatPay) {
        try {
          const result = await wechatPay.v3.pay.transactions.native({
            appid: WECHAT_APP_ID,
            mchid: WECHAT_MCH_ID,
            description: order.description,
            out_trade_no: orderId,
            notify_url: WECHAT_NOTIFY_URL,
            amount: {
              total: Math.round(order.amount * 100), // Convert to cents
              currency: 'CNY'
            }
          })
          paymentData = { qr_code: result.data.code_url }
        } catch (e) {
          console.error('WeChat Pay error:', e)
          return res.status(500).json({ error: 'WeChat Pay service error' })
        }
      } else {
        // Development mode
        paymentData = {
          qr_code: `wechat://pay/mock/${orderId}`,
          mock: true,
          message: 'WeChat Pay not configured - using mock data'
        }
      }
    } else if (paymentMethod === 'alipay') {
      if (alipaySdk) {
        try {
          const formData = new AlipaySdkPkg.AlipayFormData()
          formData.addField('notifyUrl', ALIPAY_NOTIFY_URL)
          formData.addField('bizContent', {
            outTradeNo: orderId,
            productCode: 'FAST_INSTANT_TRADE_PAY',
            totalAmount: order.amount.toFixed(2),
            subject: order.description
          })
          
          const result = await alipaySdk.exec('alipay.trade.page.pay', {}, { formData })
          paymentData = { payment_url: result }
        } catch (e) {
          console.error('Alipay error:', e)
          return res.status(500).json({ error: 'Alipay service error' })
        }
      } else {
        // Development mode
        paymentData = {
          payment_url: `alipay://pay/mock/${orderId}`,
          mock: true,
          message: 'Alipay not configured - using mock data'
        }
      }
    } else {
      return res.status(400).json({ error: 'Unsupported payment method' })
    }
    
    res.json({
      orderId,
      amount: order.amount,
      currency: order.currency,
      description: order.description,
      paymentMethod: order.paymentMethod,
      status: order.status,
      paymentData
    })
  } catch (e) {
    console.error('Create order error:', e)
    res.status(500).json({ error: 'Failed to create order' })
  }
})

/**
 * Get order status
 * GET /api/payment/order-status/:orderId
 */
app.get('/api/payment/order-status/:orderId', authMiddleware, (req, res) => {
  const { orderId } = req.params
  const order = orderStore.get(orderId)
  
  if (!order) {
    return res.status(404).json({ error: 'Order not found' })
  }
  
  if (order.userId !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' })
  }
  
  res.json(order)
})

/**
 * WeChat Pay notification webhook
 * POST /api/payment/notify/wechat
 */
app.post('/api/payment/notify/wechat', async (req, res) => {
  try {
    if (!wechatPay) {
      console.log('[dev] WeChat Pay notification received (mock mode)')
      return res.status(200).json({ code: 'SUCCESS', message: 'OK' })
    }
    
    // Verify signature and decrypt notification
    const { headers, body } = req
    const signature = headers['wechatpay-signature']
    const timestamp = headers['wechatpay-timestamp']
    const nonce = headers['wechatpay-nonce']
    const serial = headers['wechatpay-serial']
    
    // Verify and decrypt (implementation depends on your WeChat Pay setup)
    const notification = body // Simplified - implement proper verification
    
    if (notification.event_type === 'TRANSACTION.SUCCESS') {
      const orderId = notification.resource.out_trade_no
      const order = orderStore.get(orderId)
      
      if (order) {
        order.status = 'paid'
        order.updatedAt = new Date().toISOString()
        order.transactionId = notification.resource.transaction_id
        orderStore.set(orderId, order)
        console.log(`Order ${orderId} marked as paid`)
      }
    }
    
    res.status(200).json({ code: 'SUCCESS', message: 'OK' })
  } catch (e) {
    console.error('WeChat Pay notification error:', e)
    res.status(500).json({ code: 'FAIL', message: 'Internal error' })
  }
})

/**
 * Alipay notification webhook
 * POST /api/payment/notify/alipay
 */
app.post('/api/payment/notify/alipay', async (req, res) => {
  try {
    if (!alipaySdk) {
      console.log('[dev] Alipay notification received (mock mode)')
      return res.send('success')
    }
    
    // Verify Alipay signature
    const isValid = alipaySdk.checkNotifySign(req.body)
    
    if (!isValid) {
      console.error('Invalid Alipay notification signature')
      return res.send('fail')
    }
    
    const { out_trade_no: orderId, trade_status } = req.body
    
    if (trade_status === 'TRADE_SUCCESS' || trade_status === 'TRADE_FINISHED') {
      const order = orderStore.get(orderId)
      
      if (order) {
        order.status = 'paid'
        order.updatedAt = new Date().toISOString()
        order.transactionId = req.body.trade_no
        orderStore.set(orderId, order)
        console.log(`Order ${orderId} marked as paid`)
      }
    }
    
    res.send('success')
  } catch (e) {
    console.error('Alipay notification error:', e)
    res.send('fail')
  }
})

/**
 * Refund payment
 * POST /api/payment/refund
 * Body: { orderId, amount?, reason? }
 */
app.post('/api/payment/refund', authMiddleware, async (req, res) => {
  try {
    const { orderId, amount, reason = 'User requested refund' } = req.body
    
    if (!orderId) {
      return res.status(400).json({ error: 'Order ID required' })
    }
    
    const order = orderStore.get(orderId)
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' })
    }
    
    if (order.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' })
    }
    
    if (order.status !== 'paid') {
      return res.status(400).json({ error: 'Order not eligible for refund' })
    }
    
    const refundAmount = amount || order.amount
    const refundId = crypto.randomUUID()
    
    let refundResult = null
    
    if (order.paymentMethod === 'wechat' && wechatPay) {
      try {
        refundResult = await wechatPay.v3.refund.domestic.refunds({
          out_trade_no: orderId,
          out_refund_no: refundId,
          amount: {
            refund: Math.round(refundAmount * 100),
            total: Math.round(order.amount * 100),
            currency: 'CNY'
          },
          reason
        })
      } catch (e) {
        console.error('WeChat Pay refund error:', e)
        return res.status(500).json({ error: 'Refund failed' })
      }
    } else if (order.paymentMethod === 'alipay' && alipaySdk) {
      try {
        refundResult = await alipaySdk.exec('alipay.trade.refund', {
          bizContent: {
            outTradeNo: orderId,
            refundAmount: refundAmount.toFixed(2),
            refundReason: reason
          }
        })
      } catch (e) {
        console.error('Alipay refund error:', e)
        return res.status(500).json({ error: 'Refund failed' })
      }
    } else {
      // Development mode
      refundResult = {
        mock: true,
        message: 'Refund processed in development mode'
      }
    }
    
    // Update order status
    order.status = 'refunded'
    order.refundAmount = refundAmount
    order.refundId = refundId
    order.refundReason = reason
    order.updatedAt = new Date().toISOString()
    orderStore.set(orderId, order)
    
    res.json({
      success: true,
      refundId,
      amount: refundAmount,
      orderId,
      refundResult
    })
  } catch (e) {
    console.error('Refund error:', e)
    res.status(500).json({ error: 'Failed to process refund' })
  }
})

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', port: PORT })
})

app.listen(PORT, () => {
  console.log(`Auth server running on http://localhost:${PORT}`)
})