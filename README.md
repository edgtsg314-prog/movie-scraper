# IPTV Expert Custom Player

تشغيل محلي:

```cmd
npm install
npm start
```

أمثلة:

```text
http://localhost:8090/?id=550
http://localhost:8090/?id=94997&s=1&e=1
```

## الترجمات العربية

النظام لا يكتب ملفات ترجمة داخل السيرفر، لذلك يعمل على Vercel بدون خطأ `ENOENT`.

رابط اختبار الترجمة:

```text
http://localhost:8090/api?subtitle=1&id=238
```

إذا كانت الترجمة العربية متوفرة من OpenSubtitles سترجع بصيغة WebVTT مباشرة.
