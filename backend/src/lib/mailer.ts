import nodemailer, { Transporter } from 'nodemailer';

/**
 * SMTP_URL is optional. Without it we log the mail and carry on — a self-hosted
 * install with no mail server still has to be able to invite people.
 * Gmail app passwords are printed with spaces; strip them so the URL parses.
 */
const url = (process.env.SMTP_URL || '').trim().replace(/\s+/g, '');

let transporter: Transporter | null = null;
if (url) {
  transporter = nodemailer.createTransport(url);
}

export const mailEnabled = !!transporter;

export async function sendMail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<boolean> {
  if (!transporter) {
    console.warn(`SMTP_URL not set — mail to ${opts.to} not sent: ${opts.subject}`);
    return false;
  }

  try {
    const info = await transporter.sendMail({
      from: process.env.MAIL_FROM || 'no-reply@localhost',
      ...opts,
    });
    console.log(`Mail sent to ${opts.to} (${info.messageId})`);
    return true;
  } catch (error: any) {
    console.error(`Failed to send mail to ${opts.to}:`, error?.message || error);
    return false;
  }
}
