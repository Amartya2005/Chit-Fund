import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

/**
 * Outbound email (OTP codes and new-account credentials).
 *
 * SMTP credentials come only from environment variables (SMTP_USER / SMTP_PASS / ...).
 * When they are not configured, email is disabled: send* functions return
 * { success: false } and nothing is logged except the fact that email is disabled.
 * OTP codes and passwords are never written to logs.
 */
const DEFAULT_PORTAL_URL = env.portalUrl;
const SMTP_FROM = env.smtp.from;

export const transporter = env.smtp.enabled
  ? nodemailer.createTransport({
      host: env.smtp.host || undefined,
      service: !env.smtp.host && env.smtp.user.endsWith('@gmail.com') ? 'gmail' : undefined,
      port: env.smtp.port,
      secure: env.smtp.secure,
      auth: { user: env.smtp.user, pass: env.smtp.pass },
      connectionTimeout: 15000,
    })
  : null;

if (!transporter) {
  if (!env.isTest) console.warn('[EmailService] SMTP is not configured (SMTP_USER/SMTP_PASS); outbound email is disabled.');
} else if (!env.isTest) {
  // Verify email configuration on startup (non-blocking)
  transporter.verify((error) => {
    if (error) console.warn('[EmailService] SMTP connection check failed:', error.message);
    else console.log('[EmailService] SMTP connection verified.');
  });
}

type MailOptions = Parameters<ReturnType<typeof nodemailer.createTransport>['sendMail']>[0];

async function deliver(mailOptions: MailOptions, kind: string) {
  if (!transporter) return { success: false as const, error: 'Email delivery is not configured' };
  try {
    const result = await transporter.sendMail(mailOptions);
    console.log(`[EmailService] ${kind} email sent (MessageId: ${result.messageId})`);
    return { success: true as const, messageId: result.messageId as string };
  } catch (error: any) {
    console.error(`[EmailService] ${kind} email failed:`, error?.message);
    return { success: false as const, error: 'Email delivery failed' };
  }
}

/**
 * Send a 6-digit OTP email for password reset or verification
 */
export async function sendOtpEmail(to: string, otp: string, fullName: string = 'User') {
  const mailOptions = {
    from: SMTP_FROM,
    to,
    subject: 'Your Password Reset OTP - ChitKart',
    text: `Hello ${fullName},\n\nYour One-Time Password (OTP) for password reset on ChitKart is: ${otp}\n\nThis OTP is valid for 10 minutes. Please do not share this code with anyone.\n\nRegards,\nChitKart Security Team`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f6f8; margin: 0; padding: 20px; color: #1e293b; }
          .container { max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.06); border: 1px solid #e2e8f0; }
          .header { background: #3E5030; padding: 26px; text-align: center; }
          .header h1 { color: #ffffff; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: 0.5px; }
          .header p { color: #C8FF00; margin: 6px 0 0 0; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; }
          .body { padding: 32px 28px; }
          .greeting { font-size: 16px; font-weight: 600; color: #1e293b; margin-bottom: 12px; }
          .intro { font-size: 14px; color: #64748b; line-height: 1.6; margin-bottom: 24px; }
          .otp-container { background: #F4F8F0; border: 2px dashed #3E5030; border-radius: 10px; padding: 22px; text-align: center; margin: 20px 0; }
          .otp-code { font-size: 34px; font-weight: 800; letter-spacing: 8px; color: #2B3A21; margin: 0; font-family: 'Courier New', Courier, monospace; }
          .otp-expiry { font-size: 12px; color: #64748b; margin-top: 8px; font-weight: 500; }
          .notice { background: #fffbeb; border-left: 4px solid #f59e0b; padding: 12px 14px; border-radius: 6px; font-size: 13px; color: #92400e; margin: 20px 0; line-height: 1.5; }
          .footer { background: #f8fafc; padding: 18px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>ChitKart</h1>
            <p>Security Verification Service</p>
          </div>
          <div class="body">
            <div class="greeting">Hello ${fullName},</div>
            <div class="intro">
              We received a request to reset your password for your <strong>ChitKart</strong> account. Use the 6-digit verification code below to complete your request:
            </div>
            <div class="otp-container">
              <div class="otp-code">${otp}</div>
              <div class="otp-expiry">Valid for 10 minutes only</div>
            </div>
            <div class="notice">
              <strong>Security Warning:</strong> Never share this OTP with anyone, including ChitKart staff or administrators. Our team will never ask for your verification code.
            </div>
            <div class="intro" style="font-size: 12px; color: #94a3b8; margin-bottom: 0;">
              If you did not request this password reset, please ignore this email or contact support.
            </div>
          </div>
          <div class="footer">
            &copy; ${new Date().getFullYear()} ChitKart Management Platform. All rights reserved.
          </div>
        </div>
      </body>
      </html>
    `,
  };

  return deliver(mailOptions, 'OTP');
}

export interface AdminCredentialsEmailParams {
  to: string;
  fullName: string;
  username: string;
  password: string;
  role?: string;
  companyName?: string;
  companyCode?: string;
  loginUrl?: string;
}

/**
 * Automatically send login credentials to newly created Company Admin / Staff Gmail or email
 */
export async function sendAdminCredentialsEmail(params: AdminCredentialsEmailParams) {
  const {
    to,
    fullName,
    username,
    password,
    role = 'Company Administrator',
    companyName = 'ChitKart Platform',
    companyCode,
    loginUrl = DEFAULT_PORTAL_URL,
  } = params;

  const displayCompany = companyCode ? `${companyName} (${companyCode})` : companyName;

  const mailOptions = {
    from: SMTP_FROM,
    to: to.trim(),
    subject: `🎯 Your ChitKart Login Credentials - ${displayCompany}`,
    text: `Hello ${fullName},\n\nYour account credentials have been generated on the ChitKart Platform by the Super Administrator.\n\nOrganization: ${displayCompany}\nRole: ${role}\nUsername: ${username}\nPassword: ${password}\nLogin Portal: ${loginUrl}\n\nPlease sign in and update your temporary password upon first access.\n\nRegards,\nChitKart Platform Administration`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Your ChitKart Credentials</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f172a; margin: 0; padding: 24px 12px; color: #1e293b;">
        <table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 580px; background-color: #ffffff; border-radius: 14px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.15); border: 1px solid #e2e8f0;">
          <!-- Header -->
          <tr>
            <td align="center" style="background: linear-gradient(135deg, #0A2540 0%, #1E3A8A 100%); background-color: #0A2540; padding: 32px 24px;">
              <h1 style="color: #ffffff; margin: 0; font-size: 26px; font-weight: 800; letter-spacing: 0.5px;">ChitKart</h1>
              <div style="display: inline-block; background-color: #0284C7; color: #ffffff; padding: 5px 14px; border-radius: 20px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.2px; margin-top: 10px;">
                Official Account Credentials
              </div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 32px 28px;">
              <div style="font-size: 18px; font-weight: 700; color: #0f172a; margin-bottom: 8px;">
                Hello ${fullName},
              </div>
              <p style="font-size: 14px; color: #475569; line-height: 1.6; margin: 0 0 20px 0;">
                Your account credentials have been created by the <strong>Super Administrator</strong>. You can now log in to the ChitKart Management Portal with the credentials below:
              </p>

              <!-- Credentials Table (Gmail Bulletproof) -->
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f8fafc; border: 1.5px solid #cbd5e1; border-radius: 12px; margin: 20px 0; overflow: hidden;">
                <tr>
                  <td colspan="2" style="padding: 14px 18px; background-color: #f1f5f9; border-bottom: 1.5px solid #cbd5e1;">
                    <span style="font-size: 13px; font-weight: 700; color: #0369a1; text-transform: uppercase; letter-spacing: 0.8px;">
                      🛡️ Your Login Credentials
                    </span>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 18px; border-bottom: 1px solid #e2e8f0; font-size: 13px; font-weight: 600; color: #64748b; width: 40%;">
                    Company / Organization:
                  </td>
                  <td style="padding: 12px 18px; border-bottom: 1px solid #e2e8f0; font-size: 14px; font-weight: 700; color: #0f172a; text-align: right;">
                    ${displayCompany}
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 18px; border-bottom: 1px solid #e2e8f0; font-size: 13px; font-weight: 600; color: #64748b;">
                    Assigned Role:
                  </td>
                  <td style="padding: 12px 18px; border-bottom: 1px solid #e2e8f0; font-size: 14px; font-weight: 700; color: #0284c7; text-align: right;">
                    ${role}
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 18px; border-bottom: 1px solid #e2e8f0; font-size: 13px; font-weight: 600; color: #64748b;">
                    Login Username:
                  </td>
                  <td style="padding: 12px 18px; border-bottom: 1px solid #e2e8f0; text-align: right;">
                    <code style="background-color: #e2e8f0; color: #0f172a; padding: 4px 10px; border-radius: 6px; font-family: 'Courier New', Courier, monospace; font-size: 15px; font-weight: 700;">
                      ${username}
                    </code>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 14px 18px; font-size: 13px; font-weight: 600; color: #64748b;">
                    Temporary Password:
                  </td>
                  <td style="padding: 14px 18px; text-align: right;">
                    <span style="background-color: #e0f2fe; color: #0369a1; padding: 6px 14px; border-radius: 6px; font-family: 'Courier New', Courier, monospace; font-size: 16px; letter-spacing: 1px; font-weight: 800; border: 1.5px dashed #0284c7; display: inline-block;">
                      ${password}
                    </span>
                  </td>
                </tr>
              </table>

              <!-- CTA Button -->
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin: 28px 0 20px 0;">
                <tr>
                  <td align="center">
                    <a href="${loginUrl}" target="_blank" style="display: inline-block; background-color: #0284C7; color: #ffffff !important; text-decoration: none; padding: 14px 34px; border-radius: 8px; font-size: 15px; font-weight: 700; box-shadow: 0 4px 12px rgba(2,132,199,0.35);">
                      🚀 Log In to ChitKart Portal
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Security Notice -->
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #fffbeb; border-left: 4px solid #f59e0b; border-radius: 6px; margin-top: 22px;">
                <tr>
                  <td style="padding: 14px 16px; font-size: 12px; color: #92400e; line-height: 1.6;">
                    <strong>🔒 Security Instructions:</strong><br>
                    • Please sign in and immediately change your temporary password under your Profile settings.<br>
                    • Do not share or forward your login credentials to any unauthorized person.<br>
                    • Single-session policy is enforced: simultaneous logins from other devices will automatically log out older sessions.
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="background-color: #f8fafc; padding: 20px; font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0; line-height: 1.5;">
              &copy; ${new Date().getFullYear()} ChitKart Platform Management. All rights reserved.<br>
              This is an automated administrative notification sent directly to ${to}.
            </td>
          </tr>
        </table>
      </body>
      </html>
    `,
  };

  return deliver(mailOptions, 'Account credentials');
}


