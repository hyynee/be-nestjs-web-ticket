const envConfig = {
  get NODE_ENV() {
    return process.env.NODE_ENV as string;
  },
  get MONGODB_URI() {
    return process.env.MONGODB_URI as string;
  },
  get GOOGLE_CLIENT_ID() {
    return process.env.GOOGLE_CLIENT_ID as string;
  },
  get GOOGLE_CLIENT_SECRET() {
    return process.env.GOOGLE_CLIENT_SECRET as string;
  },
  get GOOGLE_CALLBACK_URL() {
    return process.env.GOOGLE_CALLBACK_URL as string;
  },
  get FRONTEND_URL() {
    return process.env.FRONTEND_URL as string;
  },
  get CLOUDINARY_CLOUD_NAME() {
    return process.env.CLOUDINARY_CLOUD_NAME as string;
  },
  get CLOUDINARY_API_KEY() {
    return process.env.CLOUDINARY_API_KEY as string;
  },
  get CLOUDINARY_API_SECRET() {
    return process.env.CLOUDINARY_API_SECRET as string;
  },
  get STRIPE_SECRET_KEY() {
    return process.env.STRIPE_SECRET_KEY as string;
  },
  get STRIPE_WEBHOOK_SECRET() {
    return process.env.STRIPE_WEBHOOK_SECRET as string;
  },
  get PAYPAL_CLIENT_ID() {
    return process.env.PAYPAL_CLIENT_ID as string;
  },
  get PAYPAL_CLIENT_SECRET() {
    return process.env.PAYPAL_CLIENT_SECRET as string;
  },
  get SECRET_KEY() {
    return process.env.SECRET_KEY as string;
  },
  get SMTP_HOST() {
    return process.env.SMTP_HOST as string;
  },
  get SMTP_PORT() {
    return process.env.SMTP_PORT as string;
  },
  get SMTP_USER() {
    return process.env.SMTP_USER as string;
  },
  get SMTP_PASS() {
    return process.env.SMTP_PASS as string;
  },
  get OLLAMA_URL() {
    return process.env.OLLAMA_URL as string;
  },
  get OLLAMA_MODEL() {
    return process.env.OLLAMA_MODEL as string;
  },
  get AUTH_COOKIE_SECURE() {
    return process.env.AUTH_COOKIE_SECURE as string;
  },
  get AUTH_COOKIE_SAME_SITE() {
    return process.env.AUTH_COOKIE_SAME_SITE as string;
  },
  get AUTH_COOKIE_DOMAIN() {
    return process.env.AUTH_COOKIE_DOMAIN as string;
  },
};

export default envConfig;
