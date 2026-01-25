import nodemailer from 'nodemailer';
import { logger } from '../utils/logger';

interface VerificationEmailParams {
  to: string;
  code: string;
}

class EmailService {
  private transporter: nodemailer.Transporter | null = null;
  private initialized = false;

  initialize(): void {
    if (this.initialized) return;

    const emailUser = process.env.EMAIL_USER;
    const emailPass = process.env.EMAIL_PASS;

    if (!emailUser || !emailPass) {
      logger.warn('Email credentials not configured. Email sending will be disabled.');
      return;
    }

    try {
      this.transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: emailUser,
          pass: emailPass,
        },
      });
      this.initialized = true;
      logger.info('Email service initialized');
    } catch (error) {
      logger.error({ error }, 'Failed to initialize email service');
    }
  }

  async sendVerificationCode({ to, code }: VerificationEmailParams): Promise<boolean> {
    if (!this.initialized) {
      this.initialize();
    }

    if (!this.transporter) {
      logger.error('Email transporter not available');
      return false;
    }

    const subject = 'ReadAloud AI - Verify Your Email';

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #6366f1; margin: 0;">ReadAloud AI</h1>
          <p style="color: #6b7280; margin-top: 8px;">Email Verification</p>
        </div>

        <div style="background: #f9fafb; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
          <p style="color: #374151; font-size: 16px; margin: 0 0 16px 0;">
            Your verification code is:
          </p>
          <div style="background: #ffffff; border: 2px solid #e5e7eb; border-radius: 8px; padding: 16px; text-align: center;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #111827;">${code}</span>
          </div>
          <p style="color: #6b7280; font-size: 14px; margin: 16px 0 0 0;">
            This code expires in 10 minutes.
          </p>
        </div>

        <div style="background: #fef3c7; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <p style="color: #92400e; font-size: 14px; margin: 0;">
            <strong>Why verify?</strong> Email verification allows you to share voices in the marketplace and recover your account on a new device.
          </p>
        </div>

        <p style="color: #9ca3af; font-size: 12px; text-align: center; margin: 0;">
          If you didn't request this code, you can safely ignore this email.
        </p>
      </div>
    `;

    const text = `
ReadAloud AI - Email Verification

Your verification code is: ${code}

This code expires in 10 minutes.

If you didn't request this code, you can safely ignore this email.
    `;

    const mailOptions = {
      from: `"ReadAloud AI" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
      text,
    };

    try {
      await this.transporter.sendMail(mailOptions);
      logger.info({ to }, 'Verification email sent');
      return true;
    } catch (error) {
      logger.error({ error, to }, 'Failed to send verification email');
      return false;
    }
  }

  async sendWelcomeEmail(to: string): Promise<boolean> {
    if (!this.initialized) {
      this.initialize();
    }

    if (!this.transporter) {
      logger.error('Email transporter not available');
      return false;
    }

    const subject = 'Welcome to ReadAloud AI!';

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #6366f1; margin: 0;">Welcome to ReadAloud AI!</h1>
        </div>

        <div style="background: #f9fafb; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
          <p style="color: #374151; font-size: 16px; margin: 0 0 16px 0;">
            Your email has been verified. You can now:
          </p>
          <ul style="color: #374151; font-size: 15px; padding-left: 20px;">
            <li style="margin-bottom: 8px;">Share your cloned voices with the community</li>
            <li style="margin-bottom: 8px;">Earn listening minutes when others use your voices</li>
            <li style="margin-bottom: 8px;">Recover your account on any device</li>
          </ul>
        </div>

        <p style="color: #6b7280; font-size: 14px; text-align: center;">
          Happy listening!<br>
          The ReadAloud AI Team
        </p>
      </div>
    `;

    const mailOptions = {
      from: `"ReadAloud AI" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
    };

    try {
      await this.transporter.sendMail(mailOptions);
      logger.info({ to }, 'Welcome email sent');
      return true;
    } catch (error) {
      logger.error({ error, to }, 'Failed to send welcome email');
      return false;
    }
  }
}

export const emailService = new EmailService();
