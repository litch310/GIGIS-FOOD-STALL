'use strict';
// SMTP email for verification and password reset links (port of email.php).
const nodemailer = require('nodemailer');

class EmailDeliveryError extends Error {}

const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

function isEmail(value) {
  return typeof value === 'string' && value.length <= 150 && EMAIL_PATTERN.test(value);
}

function smtpConfig() {
  const host = process.env.SMTP_HOST || '';
  const port = Number(process.env.SMTP_PORT || '587');
  const user = process.env.SMTP_USERNAME || '';
  // Gmail shows app passwords in groups of four; spaces are not part of it.
  const pass = (process.env.SMTP_PASSWORD || '').replace(/\s+/g, '');
  const from = process.env.SMTP_FROM || '';

  if (!host || /[^a-zA-Z0-9.-]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !user || !pass || !isEmail(from)) {
    throw new EmailDeliveryError('Email sending is not configured. Please contact the site owner.');
  }
  return { host, port, user, pass, from };
}

// Public root URL used in emailed links. Never derived from the request's
// Host header, so links cannot be pointed at another site.
function baseUrl() {
  let value = process.env.APP_BASE_URL || '';
  // Render sets RENDER_EXTERNAL_URL to the service's public URL
  if (!value && process.env.RENDER_EXTERNAL_URL) value = process.env.RENDER_EXTERNAL_URL;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    parsed = null;
  }
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new EmailDeliveryError('The application URL is not configured. Please contact the site owner.');
  }
  return value.replace(/\/+$/, '');
}

function appUrl(action, token) {
  return `${baseUrl()}/#${encodeURIComponent(action)}=${encodeURIComponent(token)}`;
}

async function sendAppEmail(to, subject, text) {
  const config = smtpConfig();
  if (!isEmail(to)) throw new EmailDeliveryError('That email address cannot receive messages.');

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    requireTLS: config.port !== 465,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 15000
  });

  try {
    await transporter.sendMail({ from: config.from, to, subject, text });
  } catch (error) {
    console.error('Email delivery failed:', error.code || '', error.responseCode || '', error.message);
    throw new EmailDeliveryError('The email could not be sent. Please try again later.');
  } finally {
    transporter.close();
  }
}

async function sendVerificationEmail(email, name, token) {
  const url = appUrl('verify', token);
  await sendAppEmail(
    email,
    "Verify your Gigi's Food House account",
    `Hi ${name},\r\n\r\nVerify your email address to activate your account:\r\n${url}\r\n\r\nThis link expires in 24 hours. If you did not create an account, you can ignore this email.`
  );
}

async function sendPasswordResetEmail(email, name, token) {
  const url = appUrl('reset', token);
  await sendAppEmail(
    email,
    "Reset your Gigi's Food House password",
    `Hi ${name},\r\n\r\nUse this link to choose a new password:\r\n${url}\r\n\r\nThis link expires in 1 hour. If you did not request a password reset, you can ignore this email.`
  );
}

module.exports = { EmailDeliveryError, isEmail, sendVerificationEmail, sendPasswordResetEmail };
