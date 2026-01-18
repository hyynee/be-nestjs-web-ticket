import config from "@app-config/config.json";

const envConfig = {
  ...config,
  MONGODB_URI: process.env.MONGODB_URI || config.MONGODB_URI,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || config.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || config.GOOGLE_CLIENT_SECRET,
  GOOGLE_CALLBACK_URL: process.env.GOOGLE_CALLBACK_URL || config.GOOGLE_CALLBACK_URL,
  FRONTEND_URL: process.env.FRONTEND_URL || config.FRONTEND_URL,
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || config.CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || config.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || config.CLOUDINARY_API_SECRET,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || config.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || config.STRIPE_WEBHOOK_SECRET,
  PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID || config.PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET || config.PAYPAL_CLIENT_SECRET,
  SMTP_HOST: process.env.SMTP_HOST || config.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT) : config.SMTP_PORT,
  SMTP_USER: process.env.SMTP_USER || config.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS || config.SMTP_PASS,
  OLLAMA_URL: process.env.OLLAMA_URL || config.OLLAMA_URL,
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || config.OLLAMA_MODEL,
};

export default envConfig;

