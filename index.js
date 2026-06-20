import os
import telebot
import gspread
from oauth2client.service_account import ServiceAccountCredentials
from google import genai
from google.genai import types
import matplotlib.pyplot as plt
import pandas as pd
import io
// ╔══════════════════════════════════════════════════════════════╗
// ║          BOT TELEGRAM LAPORAN KEUANGAN PRO                  ║
// ║  Fitur: Nota AI · Kategori · Budget · Tabungan · Hutang     ║
// ║         Laporan Harian/Bulanan/Tahunan · Google Sheets      ║
// ╚══════════════════════════════════════════════════════════════╝

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const { google } = require('googleapis');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ════════════════════════════════════════
//  KATEGORI DEFAULT
// ════════════════════════════════════════
const KATEGORI_KELUAR = [
  'makan', 'transport', 'belanja', 'tagihan', 'hiburan',
  'kesehatan', 'pendidikan', 'investasi', 'cicilan', 'lainnya'
];
const KATEGORI_MASUK = [
  'gaji', 'freelance', 'bisnis', 'investasi', 'hadiah', 'lainnya'
];

// ════════════════════════════════════════
//  SESSION STORE (ganti SQLite untuk prod)
// ════════════════════════════════════════
const db = {}; // { userId: { transaksi[], budget{}, tabungan[], hutang[], settings{} } }

function getDb(userId) {
  if (!db[userId]) {
    db[userId] = {
      transaksi: [],
      budget: {},       // { kategori: limit }
      tabungan: [],     // [{ nama, target, terkumpul, deadline }]
      hutang: [],       // [{ nama, jumlah, type:'piutang'|'hutang', lunas:false }]
      langganan: [],    // [{ nama, jumlah, tanggal, aktif }]
      settings: { nama: 'Pengguna', mata_uang: 'Rp', notif_budget: true }
    };
  }
  return db[userId];
}

// ════════════════════════════════════════
//  GOOGLE SHEETS SETUP
// ════════════════════════════════════════
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function syncKeSheets(userId, transaksi) {
  if (!process.env.SHEET_ID) return;
  try {
    const sheets = await getSheetsClient();
    const row = [
      transaksi.waktu, transaksi.tipe, transaksi.kategori,
      transaksi.jumlah, transaksi.keterangan, transaksi.toko || '',
      userId
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SHEET_ID,
      range: 'Transaksi!A:G',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] },
    });
  } catch (e) {
    console.error('Sheets error:', e.message);
  }
}

async function inisialisasiSheets() {
  if (!process.env.SHEET_ID) return;
  try {
    const sheets = await getSheetsClient();
    // Buat header jika sheet kosong
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SHEET_ID,
      range: 'Transaksi!A1:G1',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [['Waktu', 'Tipe', 'Kategori', 'Jumlah', 'Keterangan', 'Toko', 'UserID']] },
    });
    console.log('✅ Google Sheets terhubung');
  } catch (e) {
    console.error('Sheets init error:', e.message);
  }
}

// ════════════════════════════════════════
//  CLAUDE AI HELPER
// ════════════════════════════════════════
async function tanyaClaude(prompt, imageBase64 = null) {
  const content = imageBase64
    ? [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: prompt },
      ]
    : prompt;

  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-sonnet-4-6', max_tokens: 1500, messages: [{ role: 'user', content }] },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    }
  );
  return res.data.content[0].text;
}

async function downloadFoto(fileId) {
  const { data: fi } = await axios.get(
    `https://api.telegram.org/bot${process.env.BOT_TOKEN}/getFile?file_id=${fileId}`
  );
  const { data } = await axios.get(
    `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fi.result.file_path}`,
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(data).toString('base64');
}

// ════════════════════════════════════════
//  UTILITAS FORMAT
// ════════════════════════════════════════
const rp = (n) => `Rp${Number(n).toLocaleString('id-ID')}`;
const now = () => new Date();
const todayStr = () => now().toISOString().slice(0, 10);
const monthStr = () => now().toISOString().slice(0, 7);
const yearStr = () => String(now().getFullYear());

function filterByPeriod(transaksi, period) {
  return transaksi.filter((t) => {
    const tgl = t.waktu.slice(0, period.length);
    return tgl === period;
  });
}

function hitungRingkasan(list) {
  const masuk = list.filter((t) => t.tipe === 'masuk').reduce((s, t) => s + t.jumlah, 0);
  const keluar = list.filter((t) => t.tipe === 'keluar').reduce((s, t) => s + t.jumlah, 0);
  return { masuk, keluar, saldo: masuk - keluar };
}

function topKategori(list, tipe, n = 5) {
  const filtered = list.filter((t) => t.tipe === tipe);
  const map = {};
  filtered.forEach((t) => {
    map[t.kategori] = (map[t.kategori] || 0) + t.jumlah;
  });
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

function grafikBar(data, maxWidth = 20) {
  if (!data.length) return '(tidak ada data)';
  const max = Math.max(...data.map((d) => d[1]));
  return data
    .map(([kat, jml]) => {
      const pct = max > 0 ? Math.round((jml / max) * maxWidth) : 0;
      const bar = '█'.repeat(pct) + '░'.repeat(maxWidth - pct);
      return `${kat.padEnd(12)} ${bar} ${rp(jml)}`;
    })
    .join('\n');
}

// ════════════════════════════════════════
//  LAPORAN BUILDER
// ════════════════════════════════════════
function buatLaporan(data, period, label) {
  const list = filterByPeriod(data.transaksi, period);
  if (!list.length) return `📭 Tidak ada transaksi ${label}.`;
  const { masuk, keluar, saldo } = hitungRingkasan(list);
  const topKeluar = topKategori(list, 'keluar');
  const topMasuk = topKategori(list, 'masuk');
  const grafikK = grafikBar(topKeluar);
  const grafikM = grafikBar(topMasuk);

  return (
    `📊 *Laporan ${label}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 Pemasukan : ${rp(masuk)}\n` +
    `💸 Pengeluaran: ${rp(keluar)}\n` +
    `📈 Saldo     : ${rp(saldo)}\n\n` +
    `🔴 *Top Pengeluaran:*\n\`\`\`\n${grafikK}\n\`\`\`\n` +
    `🟢 *Top Pemasukan:*\n\`\`\`\n${grafikM}\n\`\`\``
  );
}

// ════════════════════════════════════════
//  /START
// ════════════════════════════════════════
bot.start((ctx) => {
  const userId = ctx.from.id;
  getDb(userId);
  ctx.replyWithMarkdown(
    `👋 Selamat datang di *Bot Keuangan Pro*!\n\n` +
    `Saya bisa bantu kamu:\n` +
    `📸 Foto nota → otomatis dibaca & dicatat\n` +
    `💬 Ketik bebas: *"makan siang 25rb"* → langsung dicatat\n\n` +
    `Ketik /menu untuk semua fitur.`
  );
});

// ════════════════════════════════════════
//  /MENU — tombol inline
// ════════════════════════════════════════
bot.command('menu', (ctx) => {
  ctx.reply(
    '🏦 *Menu Utama*',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💰 Catat Masuk', 'menu_masuk'), Markup.button.callback('💸 Catat Keluar', 'menu_keluar')],
        [Markup.button.callback('📊 Laporan', 'menu_laporan'), Markup.button.callback('📈 Analisis', 'menu_analisis')],
        [Markup.button.callback('🎯 Budget', 'menu_budget'), Markup.button.callback('🏦 Tabungan', 'menu_tabungan')],
        [Markup.button.callback('🤝 Hutang/Piutang', 'menu_hutang'), Markup.button.callback('🔁 Langganan', 'menu_langganan')],
        [Markup.button.callback('⚙️ Pengaturan', 'menu_settings'), Markup.button.callback('❓ Bantuan', 'menu_help')],
      ])
    }
  );
});

// ════════════════════════════════════════
//  CATAT TRANSAKSI (manual)
// ════════════════════════════════════════
async function catatTransaksi(ctx, tipe, args) {
  // Format: /masuk 50000 #gaji keterangan
  // ATAU   /masuk 50000 keterangan (tanpa kategori)
  const userId = ctx.from.id;
  const data = getDb(userId);
  const raw = args.join(' ');

  const jumlah = parseInt(args[0]?.replace(/[.,]/g, ''));
  if (isNaN(jumlah) || jumlah <= 0) {
    return ctx.replyWithMarkdown(
      `Format salah. Contoh:\n` +
      `\`/${tipe} 50000 #${tipe === 'masuk' ? 'gaji' : 'makan'} keterangan\``
    );
  }

  const katMatch = raw.match(/#(\w+)/);
  const kategori = katMatch ? katMatch[1].toLowerCase() : (tipe === 'masuk' ? 'lainnya' : 'lainnya');
  const keterangan = raw.replace(args[0], '').replace(/#\w+/, '').trim() || (tipe === 'masuk' ? 'Pemasukan' : 'Pengeluaran');

  const trx = { waktu: now().toISOString(), tipe, kategori, jumlah, keterangan };
  data.transaksi.push(trx);
  await syncKeSheets(userId, trx);

  // Cek budget
  let warningBudget = '';
  if (tipe === 'keluar' && data.budget[kategori]) {
    const bulanIni = filterByPeriod(data.transaksi, monthStr())
      .filter((t) => t.tipe === 'keluar' && t.kategori === kategori)
      .reduce((s, t) => s + t.jumlah, 0);
    const limit = data.budget[kategori];
    const pct = Math.round((bulanIni / limit) * 100);
    if (pct >= 100) warningBudget = `\n\n⚠️ *BUDGET ${kategori.toUpperCase()} HABIS!* (${pct}% dari ${rp(limit)})`;
    else if (pct >= 80) warningBudget = `\n\n⚠️ Budget ${kategori} sudah ${pct}% (${rp(bulanIni)} dari ${rp(limit)})`;
  }

  ctx.replyWithMarkdown(
    `✅ *${tipe === 'masuk' ? 'Pemasukan' : 'Pengeluaran'} dicatat!*\n` +
    `💰 ${rp(jumlah)} · #${kategori}\n` +
    `📝 ${keterangan}${warningBudget}`
  );
}

bot.command('masuk', (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  catatTransaksi(ctx, 'masuk', args);
});

bot.command('keluar', (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  catatTransaksi(ctx, 'keluar', args);
});

// ════════════════════════════════════════
//  CATAT BEBAS (NLP via Claude)
//  Cukup ketik: "makan siang 25rb" atau "terima gaji 3jt"
// ════════════════════════════════════════
bot.on('text', async (ctx, next) => {
  if (ctx.message.text.startsWith('/')) return next();

  const userId = ctx.from.id;
  const data = getDb(userId);
  const text = ctx.message.text;

  // Coba parse sebagai transaksi bebas
  const prompt = `Kamu adalah parser transaksi keuangan. Parse teks berikut menjadi JSON.
Teks: "${text}"

Kembalikan HANYA JSON tanpa komentar:
{
  "tipe": "masuk" atau "keluar",
  "jumlah": angka_bulat,
  "kategori": salah_satu dari [${[...KATEGORI_KELUAR, ...KATEGORI_MASUK].join(', ')}],
  "keterangan": "deskripsi singkat",
  "valid": true atau false
}

Contoh: "makan siang 25rb" → {"tipe":"keluar","jumlah":25000,"kategori":"makan","keterangan":"makan siang","valid":true}
"terima gaji 3jt" → {"tipe":"masuk","jumlah":3000000,"kategori":"gaji","keterangan":"gaji","valid":true}
Jika bukan transaksi, set valid:false.`;

  try {
    const hasil = await tanyaClaude(prompt);
    const parsed = JSON.parse(hasil.replace(/```json|```/g, '').trim());
    if (!parsed.valid) return next();

    const trx = { waktu: now().toISOString(), ...parsed };
    delete trx.valid;
    data.transaksi.push(trx);
    await syncKeSheets(userId, trx);

    ctx.replyWithMarkdown(
      `✅ *Dicatat otomatis!*\n` +
      `${parsed.tipe === 'masuk' ? '💰' : '💸'} ${rp(parsed.jumlah)} · #${parsed.kategori}\n` +
      `📝 ${parsed.keterangan}`
    );
  } catch (e) {
    // Bukan transaksi, abaikan
    return next();
  }
});

// ════════════════════════════════════════
//  FOTO NOTA
// ════════════════════════════════════════
bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const data = getDb(userId);
  await ctx.reply('📸 Membaca nota...');

  try {
    const foto = ctx.message.photo;
    const base64 = await downloadFoto(foto[foto.length - 1].file_id);

    const hasil = await tanyaClaude(
      `Ini foto nota/struk. Ekstrak dan kembalikan HANYA JSON:
{
  "toko": "nama toko atau merchant",
  "tanggal": "YYYY-MM-DD atau null",
  "total": angka_total_rupiah,
  "kategori": salah satu dari [${KATEGORI_KELUAR.join(', ')}],
  "item": [{"nama": "...", "harga": angka, "qty": angka}],
  "pajak": angka_atau_0,
  "error": null
}
Jika tidak terbaca, set error:"pesan".`,
      base64
    );

    let d;
    try { d = JSON.parse(hasil.replace(/```json|```/g, '').trim()); }
    catch { return ctx.reply('⚠️ Gagal parse. Coba foto lebih jelas.'); }

    if (d.error) return ctx.reply(`⚠️ ${d.error}`);

    const trx = {
      waktu: d.tanggal ? `${d.tanggal}T00:00:00.000Z` : now().toISOString(),
      tipe: 'keluar', kategori: d.kategori || 'belanja',
      jumlah: d.total, keterangan: d.toko || 'Belanja', toko: d.toko
    };
    data.transaksi.push(trx);
    await syncKeSheets(userId, trx);

    const itemList = (d.item || []).map((i) => `  • ${i.nama}${i.qty > 1 ? ` x${i.qty}` : ''}: ${rp(i.harga)}`).join('\n');

    ctx.replyWithMarkdown(
      `✅ *Nota berhasil dibaca!*\n\n` +
      `🏪 ${d.toko || '-'}  📅 ${d.tanggal || '-'}\n` +
      (itemList ? `\n📦 *Item:*\n${itemList}\n` : '') +
      (d.pajak ? `\n🧾 Pajak: ${rp(d.pajak)}\n` : '') +
      `\n💰 *Total: ${rp(d.total)}*\n` +
      `🏷️ Kategori: #${trx.kategori}\n\n` +
      `💾 Otomatis disimpan & sync ke Sheets ✓`
    );
  } catch (e) {
    console.error(e);
    ctx.reply('❌ Error membaca foto. Coba lagi.');
  }
});

// ════════════════════════════════════════
//  LAPORAN
// ════════════════════════════════════════
bot.command('laporan', (ctx) => {
  ctx.reply(
    '📊 Pilih periode laporan:',
    Markup.inlineKeyboard([
      [Markup.button.callback('📅 Hari Ini', 'lap_hari'), Markup.button.callback('📅 Kemarin', 'lap_kemarin')],
      [Markup.button.callback('🗓️ Minggu Ini', 'lap_minggu'), Markup.button.callback('📆 Bulan Ini', 'lap_bulan')],
      [Markup.button.callback('📆 Bulan Lalu', 'lap_bulanlalu'), Markup.button.callback('🗓️ Tahun Ini', 'lap_tahun')],
      [Markup.button.callback('📊 Per Kategori', 'lap_kategori'), Markup.button.callback('📋 Semua Transaksi', 'lap_semua')],
    ])
  );
});

bot.action('lap_hari', (ctx) => {
  const d = getDb(ctx.from.id);
  ctx.replyWithMarkdown(buatLaporan(d, todayStr(), 'Hari Ini'));
  ctx.answerCbQuery();
});

bot.action('lap_kemarin', (ctx) => {
  const d = getDb(ctx.from.id);
  const kmrn = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  ctx.replyWithMarkdown(buatLaporan(d, kmrn, 'Kemarin'));
  ctx.answerCbQuery();
});

bot.action('lap_bulan', (ctx) => {
  const d = getDb(ctx.from.id);
  ctx.replyWithMarkdown(buatLaporan(d, monthStr(), `Bulan ${monthStr()}`));
  ctx.answerCbQuery();
});

bot.action('lap_bulanlalu', (ctx) => {
  const d = getDb(ctx.from.id);
  const bl = new Date(now().getFullYear(), now().getMonth() - 1).toISOString().slice(0, 7);
  ctx.replyWithMarkdown(buatLaporan(d, bl, `Bulan ${bl}`));
  ctx.answerCbQuery();
});

bot.action('lap_tahun', (ctx) => {
  const d = getDb(ctx.from.id);
  ctx.replyWithMarkdown(buatLaporan(d, yearStr(), `Tahun ${yearStr()}`));
  ctx.answerCbQuery();
});

bot.action('lap_minggu', (ctx) => {
  const d = getDb(ctx.from.id);
  const senin = new Date(); senin.setDate(senin.getDate() - senin.getDay() + 1);
  const list = d.transaksi.filter((t) => new Date(t.waktu) >= senin);
  const { masuk, keluar, saldo } = hitungRingkasan(list);
  ctx.replyWithMarkdown(
    `📊 *Laporan Minggu Ini*\n` +
    `💰 Pemasukan : ${rp(masuk)}\n💸 Pengeluaran: ${rp(keluar)}\n📈 Saldo: ${rp(saldo)}`
  );
  ctx.answerCbQuery();
});

bot.action('lap_kategori', (ctx) => {
  const d = getDb(ctx.from.id);
  const list = filterByPeriod(d.transaksi, monthStr());
  const topK = topKategori(list, 'keluar', 10);
  const topM = topKategori(list, 'masuk', 5);
  ctx.replyWithMarkdown(
    `📊 *Laporan Per Kategori — ${monthStr()}*\n\n` +
    `🔴 *Pengeluaran per kategori:*\n\`\`\`\n${grafikBar(topK)}\n\`\`\`\n` +
    `🟢 *Pemasukan per kategori:*\n\`\`\`\n${grafikBar(topM)}\n\`\`\``
  );
  ctx.answerCbQuery();
});

bot.action('lap_semua', (ctx) => {
  const d = getDb(ctx.from.id);
  const list = d.transaksi.slice(-20).reverse();
  if (!list.length) return ctx.replyWithMarkdown('📭 Belum ada transaksi.');
  const rows = list.map((t) => {
    const icon = t.tipe === 'masuk' ? '🟢' : '🔴';
    return `${icon} ${t.waktu.slice(0, 10)} | #${t.kategori} | ${rp(t.jumlah)} | ${t.keterangan}`;
  }).join('\n');
  ctx.replyWithMarkdown(`📋 *20 Transaksi Terakhir:*\n\`\`\`\n${rows}\n\`\`\``);
  ctx.answerCbQuery();
});

// ════════════════════════════════════════
//  ANALISIS AI
// ════════════════════════════════════════
bot.command('analisis', async (ctx) => {
  const d = getDb(ctx.from.id);
  const list = filterByPeriod(d.transaksi, monthStr());
  if (!list.length) return ctx.reply('📭 Belum ada data bulan ini untuk dianalisis.');

  await ctx.reply('🧠 Sedang menganalisis keuanganmu...');

  const { masuk, keluar, saldo } = hitungRingkasan(list);
  const topK = topKategori(list, 'keluar', 5);
  const topM = topKategori(list, 'masuk', 3);
  const ringkasan = `Bulan ${monthStr()}: Pemasukan ${rp(masuk)}, Pengeluaran ${rp(keluar)}, Saldo ${rp(saldo)}.
Top pengeluaran: ${topK.map(([k, v]) => `${k}=${rp(v)}`).join(', ')}.
Top pemasukan: ${topM.map(([k, v]) => `${k}=${rp(v)}`).join(', ')}.
Budget aktif: ${JSON.stringify(d.budget)}.
Tabungan: ${d.tabungan.map((t) => `${t.nama} ${rp(t.terkumpul)}/${rp(t.target)}`).join(', ') || 'tidak ada'}.
Hutang/piutang: ${d.hutang.filter((h) => !h.lunas).map((h) => `${h.type} ${h.nama} ${rp(h.jumlah)}`).join(', ') || 'tidak ada'}.`;

  const analisis = await tanyaClaude(
    `Kamu adalah analis keuangan personal Indonesia. Analisis data keuangan berikut secara detail:\n\n${ringkasan}\n\n` +
    `Berikan:\n1. Evaluasi kondisi keuangan (sehat/perlu perhatian/kritis)\n` +
    `2. Kategori pengeluaran terboros dan dampaknya\n` +
    `3. 3-5 saran konkret untuk bulan depan (dengan estimasi penghematan rupiah)\n` +
    `4. Prediksi tabungan jika saran dijalankan\n` +
    `5. Skor keuangan 1-100 beserta alasannya\n\n` +
    `Jawab dalam bahasa Indonesia, pakai emoji, singkat tapi padat.`
  );
  ctx.reply(analisis);
});

// ════════════════════════════════════════
//  BUDGET
// ════════════════════════════════════════
bot.command('budget', (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  const userId = ctx.from.id;
  const d = getDb(userId);

  if (!args.length) {
    // Tampilkan semua budget
    if (!Object.keys(d.budget).length) {
      return ctx.replyWithMarkdown(
        `🎯 *Budget Bulan Ini*\nBelum ada budget.\n\nSet budget: \`/budget makan 500000\``
      );
    }
    const list = filterByPeriod(d.transaksi, monthStr());
    const rows = Object.entries(d.budget).map(([kat, limit]) => {
      const terpakai = list.filter((t) => t.tipe === 'keluar' && t.kategori === kat).reduce((s, t) => s + t.jumlah, 0);
      const pct = Math.round((terpakai / limit) * 100);
      const bar = pct >= 100 ? '🔴' : pct >= 80 ? '🟡' : '🟢';
      return `${bar} *${kat}*: ${rp(terpakai)} / ${rp(limit)} (${pct}%)`;
    }).join('\n');
    return ctx.replyWithMarkdown(`🎯 *Budget Bulan ${monthStr()}*\n\n${rows}`);
  }

  // Set budget: /budget makan 500000
  const [kategori, limitStr] = args;
  const limit = parseInt(limitStr?.replace(/[.,]/g, ''));
  if (!kategori || isNaN(limit)) {
    return ctx.replyWithMarkdown('Format: `/budget [kategori] [jumlah]`\nContoh: `/budget makan 500000`');
  }
  d.budget[kategori.toLowerCase()] = limit;
  ctx.replyWithMarkdown(`✅ Budget *${kategori}* diset ke *${rp(limit)}/bulan*`);
});

// ════════════════════════════════════════
//  TABUNGAN / GOALS
// ════════════════════════════════════════
bot.command('tabungan', (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  const d = getDb(ctx.from.id);

  if (!args.length) {
    if (!d.tabungan.length) return ctx.reply('🏦 Belum ada target tabungan.\n\nBuat: /tabungan baru [nama] [target]
# ================= CONFIGURATION =================
TOKEN = os.environ.get('8864074125:AAGDEdUFtqHgKaeUDcG4w_YscC_8cs1oDTs')
GEMINI_KEY = os.environ.get('AIzaSyB0Si1e_4iOHkyJtS2jno3_-H9ep1bqW0M')

bot = telebot.TeleBot("8864074125:AAGDEdUFtqHgKaeUDcG4w_YscC_8cs1oDTs")
ai_client = genai.Client(api_key=AIzaSyB0Si1e_4iOHkyJtS2jno3_-H9ep1bqW0M)


# =================================================

# 1. FITUR BACA NOTA/STRUK DARI FOTO
@bot.message_handler(content_types=['photo'])
def handle_photo(message):
    bot.reply_to(message, "⏳ Sedang membaca nota dengan AI... Mohon tunggu.")
    
    # Download foto dari Telegram
    file_info = bot.get_file(message.photo[-1].file_id)
    downloaded_file = bot.download_file(file_info.file_path)
    
    # Analisis dengan Gemini API
    image_part = types.Part.from_bytes(data=downloaded_file, mime_type="image/jpeg")
    prompt = """Analisis struk belanja ini. Berikan output dalam format JSON mentah saja tanpa markdown, dengan key:
    {"tipe": "Pengeluaran", "nominal": angka_saja, "kategori": "kategori_yg_cocok", "keterangan": "nama_toko_dan_barang_utama"}"""
    
    try:
        response = ai_client.models.generate_content(
            model='gemini-2.5-flash',
            contents=[image_part, prompt]
        )
        
        # Parse hasil dan simpan ke Google Sheets
        data = eval(response.text.strip().replace("```json", "").replace("```", ""))
        
        # Simpan ke Google Sheets: [Tanggal, Tipe, Nominal, Kategori, Keterangan]
        from datetime import datetime
        tanggal = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        sheet.append_row([tanggal, data['tipe'], data['nominal'], data['kategori'], data['keterangan']])
        
        bot.reply_to(message, f"✅ **Nota Berhasil Dicatat!**\n\n💰 *Total:* Rp{data['nominal']:,}\n🗂️ *Kategori:* {data['kategori']}\n📝 *Info:* {data['keterangan']}\n\n*Otomatis tersinkron ke Google Sheets!*")
    except Exception as e:
        bot.reply_to(message, f"❌ Gagal membaca nota. Pastikan foto jelas. Error: {str(e)}")

# 2. PERINTAH /BOROS (ANALISIS TERBOROS)
@bot.message_handler(commands=['boros'])
def analisa_boros(message):
    all_data = sheet.get_all_records()
    if not all_data:
        return bot.reply_to(message, "Belum ada data keuangan.")
        
    df = pd.DataFrame(all_data)
    df_pengeluaran = df[df['Tipe'].str.lower() == 'pengeluaran']
    
    if df_pengeluaran.empty:
        return bot.reply_to(message, "Belum ada data pengeluaran.")
        
    # Kelompokkan berdasarkan kategori
    terboros = df_pengeluaran.groupby('Kategori')['Nominal'].sum().reset_index()
    terboros = terboros.sort_values(by='Nominal', ascending=False)
    
    kategori_utama = terboros.iloc[0]['Kategori']
    nominal_utama = terboros.iloc[0]['Nominal']
    
    respon = f"🚨 **Analisis Pemakaian Terboros** 🚨\n\n"
    respon += f"Kategori paling boros saat ini adalah **{kategori_utama}** dengan total pengeluaran **Rp{nominal_utama:,}**.\n\n"
    respon += "Daftar Pengeluaran per Kategori:\n"
    
    for idx, row in terboros.iterrows():
        respon += f"- {row['Kategori']}: Rp{row['Nominal']:,}\n"
        
    bot.reply_to(message, respon)

# 3. PERINTAH /GRAFIK
@bot.message_handler(commands=['grafik'])
def kirim_grafik(message):
    all_data = sheet.get_all_records()
    df = pd.DataFrame(all_data)
    df_pengeluaran = df[df['Tipe'].str.lower() == 'pengeluaran']
    
    # Membuat Pie Chart
    data_grafik = df_pengeluaran.groupby('Kategori')['Nominal'].sum()
    
    plt.figure(figsize=(6,6))
    data_grafik.plot(kind='pie', autopct='%1.1f%%', startangle=90)
    plt.title('Persentase Pengeluaran')
    plt.ylabel('')
    
    # Simpan grafik ke memori buffer
    buf = io.BytesIO()
    plt.savefig(buf, format='png', bbox_inches='tight')
    buf.seek(0)
    plt.close()
    
    bot.send_photo(message.chat.id, buf, caption="📊 Ini adalah grafik pengeluaranmu bulan ini.")

# Jalankan Bot
print("Bot Keuangan siap berjalan...")
bot.infinity_polling()
