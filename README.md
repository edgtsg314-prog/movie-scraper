# IPTV Expert Player + Live Links

تشغيل:

```bash
npm install
npm start
```

المشغل:

```text
http://localhost:8090/?id=550
http://localhost:8090/?id=1396&s=1&e=1
```

إدارة روابط البث المباشر:

```text
http://localhost:8090/live-admin.html
```

أضف القناة ورابطها الحقيقي، وسيولد النظام رابطًا مختصرًا مثل:

```text
http://localhost:8090/?live=beIN-sports-abc123
```

المستخدم لا يرى الرابط الحقيقي، ويستطيع المشغل فتح M3U8/MP4 أو Embed حسب نوع الرابط.
