# Mobile playback fix

تم تعديل تشغيل الجوالات خصوصًا iPhone/Safari:

- إجبار iPhone/Safari على استخدام مشغل HLS الأصلي بدل hls.js.
- إصلاح إعادة كتابة روابط m3u8 بالكامل، بما فيها:
  - روابط المقاطع TS/M4S
  - روابط المفاتيح EXT-X-KEY
  - روابط EXT-X-MAP
  - روابط playlists الداخلية
- تحسين Headers المهمة للجوال مثل Range و Content-Range و Accept-Ranges.
- إزالة crossorigin من الفيديو لأن التشغيل يتم عبر Proxy من نفس الدومين.
- زيادة مهلة بدء التشغيل على الجوال بدل الفشل السريع.

## التشغيل

```bash
npm install
npm start
```

ثم افتح:

```text
http://localhost:8090/?id=278
```

على الجوال استخدم IP الجهاز بدل localhost، مثال:

```text
http://192.168.1.10:8090/?id=278
```
