# KLO Player + OpenSubtitles

## التشغيل
- فيلم: `/?id=550`
- حلقة: `/?id=94997&s=1&e=1`
- اختيار لغات الترجمة: `/?id=550&lang=ar,en`

## OpenSubtitles
ضع هذه المتغيرات في Vercel > Project Settings > Environment Variables:

```txt
OPENSUBTITLES_API_KEY=your_api_key
OPENSUBTITLES_USER_AGENT=KLOStream/1.0
```

بدون `OPENSUBTITLES_API_KEY` سيعمل المشغل، لكن لن يتم جلب الترجمات تلقائياً.

## الإعلانات
المشغل يحاول أولاً تشغيل Direct Mode من `/api?id=...` داخل مشغل KLO الخاص، وهذا لا يعرض iframe خارجي وبالتالي لا توجد popups من صفحة خارجية.

إذا فشل استخراج الرابط المباشر، سيظهر زر تشغيل المصدر الاحتياطي عبر VidLink iframe. في هذا الوضع لا يمكن ضمان منع الإعلانات 100% لأن الصفحة الخارجية هي التي تتحكم بالمحتوى داخل iframe.
