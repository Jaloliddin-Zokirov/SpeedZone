# SpeedZone

SpeedZone — bu brauzer orqali ishlaydigan zamonaviy internet tezligini sinash vositasi. U ping (latensiya), yuklab olish va yuklash tezligini bosqichma-bosqich o‘lchab, foydalanuvchiga real vaqt ko‘rsatkichlarini taqdim etadi.

## Qisqacha tavsif
Single-page Next.js ilovasi foydalanuvchi brauzeridan to‘g‘ridan to‘g‘ri testlarni ishga tushiradi, tashqi xizmatlardan (Cloudflare va ipwho.is) olingan ma’lumotlar bilan boyitadi hamda foydalanuvchi tanlagan test serveriga moslashadi. Ilova Tailwind CSS asosidagi UI, ko‘p oqimli o‘lchovlar va to‘liq TypeScript tiplarini qo‘llaydi.

## Asosiy funksiyalar
- Ping va jitter qiymatlarini bir nechta parallel so‘rovlar asosida hisoblash
- Streaming orqali yuklab olish tezligini aniqlash va grafik ko‘rsatkichni moslashtirish
- XHR yordamida yuqori hajmli random ma’lumotlar bilan yuklash testini bajarish
- Cloudflare meta API va ipwho.is orqali tarmoq manzili, ISP va test nuqtasi haqidagi ma’lumotlarni ko‘rsatish
- Server tanlash modali va diagnostika paneli bilan foydalanuvchi tajribasini yaxshilash

## Texnologiyalar
- Next.js 15 (App Router) va React 19
- TypeScript va zamonaviy React hook’lari
- Tailwind CSS va global dark tema
- Node.js serverless route’lari (`app/api/*`) bilan HTTP streaming

## Loyiha tuzilmasi
```text
SpeedZone/
├── app/
│   ├── page.tsx           # Test jarayoni, UI va holat boshqaruvi
│   ├── layout.tsx         # Global HTML sathi va metadata
│   ├── globals.css        # Tailwind bazasi va dark fon
│   └── api/
│       ├── ping/route.ts      # 204 javob bilan ping testi
│       ├── download/route.ts  # Random byte stream (fallback)
│       └── upload/route.ts    # Keluvchi ma’lumotni sanash
├── package.json           # Skriptlar va bog‘liqliklar
├── tailwind.config.ts     # Tailwind skan yo‘llari
└── tsconfig.json          # TypeScript konfiguratsiyasi
```

## O‘rnatish va ishga tushirish
1. Komp’yuteringizda Node.js 18.18+ (yoki 20+) o‘rnatilganini tekshiring.
2. Bog‘liqliklarni o‘rnating:
   ```bash
   npm install
   ```
3. Mahalliy serverni ishga tushiring:
   ```bash
   npm run dev
   ```
4. Brauzerdan `http://localhost:3000` manziliga kiring.
5. Ishlab chiqarish build’i uchun:
   ```bash
   npm run build && npm run start
   ```

## NPM skriptlari
- `npm run dev` – Next.js dev serveri (`http://localhost:3000`)
- `npm run build` – ishlab chiqarish build’i
- `npm run start` – production rejimda serverni ishga tushirish
- `npm run lint` – ESLint (Next.js konfiguratsiyasi bilan)

## Konfiguratsiya va muhit o‘zgaruvchilari
- `NEXT_PUBLIC_SpeedZone_DOWNLOAD_URL` – masofaviy yuklab olish endpoint’i (standartda Cloudflare `__down`)
- `NEXT_PUBLIC_SpeedZone_UPLOAD_URL` – masofaviy yuklash endpoint’i (standartda Cloudflare `__up`)
- `NEXT_PUBLIC_SpeedZone_DOWNLOAD_BYTES` – bir test siklida so‘raladigan byte miqdori (`200MB` fallback)

Masofaviy URL manzillar bo‘sh yoki yetib bo‘lmasa, ilova avtomatik holda lokal `/api/download` va `/api/upload` marshrutlariga qaytadi.

## O‘lchov jarayoni qanday ishlaydi?
- **Ping**: `/api/ping` ga 4 tadan 6 sikl parallel so‘rov yuborilib, eng barqaror qiymatlar o‘rtachasi va jitter hisoblanadi.
- **Yuklab olish**: Fetch streaming bilan bir nechta ishchi o‘qim 17 soniya davomida random byte’larni oladi, tezlik real vaqtda MBps ko‘rinishida hisoblanadi.
- **Yuklash**: XMLHttpRequest parallel ishchilari random payload’larni yuboradi; uzilishlar bo‘lsa lokal fallback ishga tushadi.
- **Tarmoq ma’lumotlari**: `ipwho.is` API’dan IP, ISP, shahar va vaqt zonasi, `speed.cloudflare.com/meta` dan Cloudflare PoP haqida ma’lumot olinadi.

## UI va foydalanuvchi tajribasi
- Adaptive gauge komponenti ping/yuklab olish/yuklash bosqichlariga mos ko‘rsatkich beradi.
- Diagnostika paneli test natijalari, tanlangan server, davomiylik va real vaqt’dagi ogohlantirishlarni ko‘rsatadi.
- Server tanlash modali `SERVER_POOL` massiviga asoslanadi; sozlamalarni `app/page.tsx` ichida tahrirlash mumkin.

## Qo‘shimcha eslatmalar
- Streaming marshrutlar `runtime = "nodejs"` va `dynamic = "force-dynamic"` bilan konfiguratsiya qilingan, shuning uchun edge muhitga majburan joylashtirish tavsiya etilmaydi.
- `app/page.tsx` ichida `crypto.getRandomValues` va Node `crypto.randomBytes` kombinatsiyasi ishlatiladi; HTTPS ustida ishga tushirish xavfsizlik jihatidan muhim.
- Tashqi API’lardan foydalanilgani sababli ishlab chiqarish deploy’i uchun CORS va tarmoq siyosatlarini tekshirib qo‘ying.
