# Movie Scraper - Custom Player + Smart Arabic Subtitles

## التشغيل المحلي
```bash
npm install
npm start
```

افتح:
```text
http://localhost:8090/?id=238
```

## اختبار الترجمات
قائمة الترجمات العربية المتاحة:
```text
/api?subtitle_list=1&id=238
```

تحميل أفضل ترجمة عربية بصيغة VTT:
```text
/api?subtitle=1&id=238
```

اختيار ترجمة ثانية/ثالثة:
```text
/api?subtitle=1&id=238&choice=1
```

## الجديد
- يحول TMDB ID إلى IMDb ID تلقائيًا قبل البحث في OpenSubtitles.
- يجلب كل الترجمات العربية ويرتبها بنظام نقاط.
- يختار الأفضل تلقائيًا بدل أول نتيجة عشوائية.
- يدعم اختيار أكثر من ترجمة عربية من قائمة الإعدادات.
- يدعم تقديم/تأخير الترجمة من المشغل بدون تعديل الملف.
- يعرض الترجمة العربية Overlay فوق الفيديو لضمان ظهورها في كل المتصفحات.
- لا يكتب ملفات داخل Vercel، لذلك لا تظهر مشكلة ENOENT.


## التعديلات الجديدة
- إخفاء أزرار المشغل عند الضغط على الشاشة، وتظهر فور أول حركة ماوس أو لمس.
- إصلاح زر ملء الشاشة للجوال، مع دعم iOS عبر `webkitEnterFullscreen`.
- دعم رابط الحلقات بالشكل:
  `/id=1396&s=1&e=1`
  أو الشكل القديم:
  `/?id=1396&s=1&e=1`
- إضافة زر الحلقة السابقة والحلقة التالية للمسلسلات.


## Live TV support
You can now open live channels using a clean internal ID:

```txt
http://localhost:8090/?live=Bein1
```

Edit channel sources here:

```txt
data/live-channels.json
```

Example:

```json
{
  "id": "Bein1",
  "name": "beIN Sports 1",
  "logo": "https://example.com/logo.png",
  "url": "https://your-legal-source.com/live/bein1.m3u8",
  "type": "hls"
}
```

Supported types: `hls`, `mp4`, `webm`, `embed`, `auto`.

You can also list channels:

```txt
/api?live_list=1
```
