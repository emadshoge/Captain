import type { ApiConfig } from '@captain/config';
import nodemailer, { type Transporter } from 'nodemailer';

export type Channel = 'sms' | 'email';

export interface OtpMessage {
  destination: string;
  code: string;
  ttlMinutes: number;
}

export interface OtpSender {
  readonly channel: Channel;
  /** Recorded on the challenge; `log_only` marks simulated delivery. */
  readonly provider: string;
  readonly available: boolean;
  send(message: OtpMessage): Promise<void>;
}

export class DeliveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DeliveryError';
  }
}

export function otpText({ code, ttlMinutes }: OtpMessage): string {
  // English only until launch languages and approved wording exist (D-L10N, D-LEGAL).
  return `Your Captain code is ${code}. It expires in ${ttlMinutes} minutes. Never share this code.`;
}

export interface OutboxEntry {
  channel: Channel;
  destination: string;
  text: string;
  code: string;
  sentAt: string;
}

/**
 * Development/test "delivery": keeps messages in memory for the dev outbox
 * endpoint. NOT a real delivery. Refused in production by the config guard.
 */
export class LogOnlySender implements OtpSender {
  readonly provider = 'log_only';
  readonly available = true;
  private static readonly MAX = 200;
  readonly outbox: OutboxEntry[] = [];

  constructor(readonly channel: Channel) {}

  async send(message: OtpMessage): Promise<void> {
    this.outbox.push({
      channel: this.channel,
      destination: message.destination,
      text: otpText(message),
      code: message.code,
      sentAt: new Date().toISOString(),
    });
    if (this.outbox.length > LogOnlySender.MAX) this.outbox.shift();
  }
}

/** Channel not configured: requests get CHANNEL_UNAVAILABLE. */
export class UnavailableSender implements OtpSender {
  readonly provider = 'none';
  readonly available = false;
  constructor(readonly channel: Channel) {}
  async send(): Promise<void> {
    throw new DeliveryError(`${this.channel} delivery is not configured`);
  }
}

/**
 * Email over SMTP (RFC 5321) via nodemailer. Provider-neutral: works with
 * any SMTP service the owner chooses (D-EMAIL). Real delivery is verified only
 * when a message is actually received (launch checklist L2).
 */
export class SmtpEmailSender implements OtpSender {
  readonly channel = 'email' as const;
  readonly provider = 'smtp';
  readonly available = true;
  private readonly transport: Transporter;

  constructor(private readonly config: ApiConfig) {
    this.transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      requireTLS: !config.SMTP_SECURE && config.SMTP_REQUIRE_TLS,
      auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }

  async send(message: OtpMessage): Promise<void> {
    try {
      await this.transport.sendMail({
        from: this.config.EMAIL_FROM,
        to: message.destination,
        subject: 'Your Captain sign-in code',
        text: otpText(message),
      });
    } catch (error) {
      throw new DeliveryError('SMTP delivery failed', { cause: error });
    }
  }
}

export interface OtpSenders {
  sms: OtpSender;
  email: OtpSender;
}

export function createOtpSenders(config: ApiConfig): OtpSenders {
  // SMS: GeezSMS adapter is BLOCKED until its official API documentation is
  // reviewed (user action B1/B3). Only the development log-only sender exists.
  const sms: OtpSender =
    config.OTP_SMS_PROVIDER === 'log_only'
      ? new LogOnlySender('sms')
      : new UnavailableSender('sms');
  const email: OtpSender =
    config.OTP_EMAIL_PROVIDER === 'smtp'
      ? new SmtpEmailSender(config)
      : config.OTP_EMAIL_PROVIDER === 'log_only'
        ? new LogOnlySender('email')
        : new UnavailableSender('email');
  return { sms, email };
}
