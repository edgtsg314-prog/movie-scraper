# ربط الترجمات الخاصة

تمت إضافة دعم روابط الترجمة الخاصة داخل رابط المشغل مباشرة، مع تحويل SRT إلى WebVTT من نفس الدومين حتى تعمل على iPhone/Safari/Android/TV.

## فيلم

```txt
/?id=550&sub=https://yourdomain.com/subs/550-ar.vtt&sub_label=العربية&sub_lang=ar
```

## مسلسل

```txt
/?id=94997&s=1&e=1&sub=https://yourdomain.com/subs/94997-s01e01-ar.srt&sub_label=العربية&sub_lang=ar
```

## أكثر من ترجمة

```txt
/?id=550&sub=https://yourdomain.com/ar.vtt&sub=https://yourdomain.com/en.vtt&sub_label=العربية&sub_label=English&sub_lang=ar&sub_lang=en
```

## الصيغة الأفضل

الأفضل WebVTT:

```vtt
WEBVTT

00:00:01.000 --> 00:00:04.000
مرحبا بكم
```

لكن SRT مدعوم وسيتم تحويله تلقائياً عبر:

```txt
/api?subtitle_url=https://yourdomain.com/file.srt
```

## مهم جداً

- رابط الترجمة لازم يكون رابط مباشر وليس صفحة تحميل.
- يفضل رفع الترجمات على نفس الدومين أو Cloudflare R2 / S3 / GitHub raw / Vercel public.
- لا تستخدم Google Drive/Dropbox كرابط صفحة مشاركة، إلا إذا حولته لرابط تحميل مباشر.
- للأجهزة خصوصاً iPhone، المشغل يستخدم `<track>` حقيقي من نفس الدومين عبر البروكسي، وليس overlay فقط.
