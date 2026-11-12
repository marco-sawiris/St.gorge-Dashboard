import rateLimit from 'express-rate-limit';

// Strict Rate Limiting for Auth Login: Max 5 failed attempts per 15 minutes per IP
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts total per IP
  message: {
    error: 'تم تجاوز عدد محاولات الدخول المسموح بها من هذا العنوان. يرجى الانتظار 15 دقيقة قبل المحاولة مجدداً.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// General API Rate Limiting: Max 200 requests per minute
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: {
    error: 'تم تجاوز الحد الأقصى لعدد الطلبات في الدقيقة. يرجى المحاولة بعد قليل.'
  },
  standardHeaders: true,
  legacyHeaders: false
});
