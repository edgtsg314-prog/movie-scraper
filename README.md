# FilmVibe Player Fix

## التشغيل
```bash
npm install
npm start
```

افتح:
```text
http://localhost:8090/?id=1301421
```

للجوال على نفس الشبكة:
```text
http://YOUR_PC_IP:8090/?id=1301421
```

## فحص سريع
```text
/api/health
/api/resolve?id=1301421
/api?resolve=1&id=1301421
```

## أهم التعديلات
- إضافة مسار ثابت `/api/resolve` بجانب `/api?resolve=1`.
- Timeout للفيديو حتى لا يبقى الجوال عالقًا على شاشة التحميل.
- Timeout لمزود VidLink و OpenSubtitles.
- التشغيل يبدأ بدون انتظار الترجمة.
- الترجمة تعمل كـ WebVTT `<track>` لدعم iPhone Full Screen.
- تحسين Proxy الفيديو مع Range/CORS.
- شاشة تحميل نظيفة بدون أزرار.
