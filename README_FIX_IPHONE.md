# FilmVibe iPhone Native Player Fix

تم تعديل التشغيل بحيث لا يتم تمرير صفحات VidSrc/VidSec أو أي embed إلى مشغل الفيديو.

## ما تم إصلاحه
- منع ظهور مشغل VidSrc/VidSec على iPhone.
- منع أي رابط HTML/embed من الدخول إلى `<video>`.
- السماح فقط بروابط الفيديو الأصلية: HLS/M3U8 و MP4 و WEBM و DASH.
- Proxy يرفض أي رد HTML بدل بثه للمستخدم.
- إبقاء التشغيل داخل مشغل FilmVibe فقط بدون iframe وبدون إعلانات مزود.

## التشغيل
```bash
npm install
npm start
```

الرابط المحلي غالبًا:
`http://localhost:8090`
