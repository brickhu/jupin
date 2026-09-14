import nodemailer from 'nodemailer'

const transporter = nodemailer.createTransport({
  host: 'localhost',
  port: 1025,
  secure: false,
  ignoreTLS: true,
})

export async function sendVerificationCode(email: string, code: string): Promise<void> {
  // 本地开发：控制台打印验证码
  console.log(`[验证码] ${email} -> ${code}`)

  // 异步发送邮件，不阻塞
  transporter.sendMail({
    from: process.env.EMAIL_FROM || 'noreply@jushuo.com',
    to: email,
    subject: '句说 - 邮箱验证码',
    text: `您的验证码是：${code}，有效期 10 分钟。`,
    html: `
      <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto;">
        <h2 style="color: #4f46e5;">句说</h2>
        <p>您的验证码是：</p>
        <div style="font-size: 32px; font-weight: bold; color: #4f46e5; letter-spacing: 8px; text-align: center; padding: 16px; background: #f5f3ff; border-radius: 8px;">
          ${code}
        </div>
        <p style="color: #888; font-size: 14px;">有效期 10 分钟，请勿泄露给他人。</p>
        <p style="color: #aaa; font-size: 12px;">—— 句说，英文短句开口说</p>
      </div>
    `,
  }).then(() => {
    console.log(`[邮件] 已发送至 ${email}`)
  }).catch((err) => {
    console.warn(`[邮件] 发送失败 ${email}:`, err.message)
  })
}