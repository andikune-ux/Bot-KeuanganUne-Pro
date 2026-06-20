import os
import telebot
import gspread
from oauth2client.service_account import ServiceAccountCredentials
from google import genai
from google.genai import types
import matplotlib.pyplot as plt
import pandas as pd
import io

# ================= CONFIGURATION =================
TOKEN = os.environ.get('8864074125:AAGDEdUFtqHgKaeUDcG4w_YscC_8cs1oDTs')
GEMINI_KEY = os.environ.get('AIzaSyB0Si1e_4iOHkyJtS2jno3_-H9ep1bqW0M')
SPREADSHEET_ID = os.environ.get('1QQzKXtzvD4Tsj-qrF13aXYJl9Kznozx3BcPY9Tg2uEg')

bot = telebot.TeleBot("8864074125:AAGDEdUFtqHgKaeUDcG4w_YscC_8cs1oDTs")
ai_client = genai.Client(api_key=AIzaSyB0Si1e_4iOHkyJtS2jno3_-H9ep1bqW0M)

# Google Sheets Setup
scope = ['https://spreadsheets.google.com/feeds', 'https://www.googleapis.com/auth/drive']
# Railway/Termux membaca kredensial dari file JSON atau Env
creds = ServiceAccountCredentials.from_json_keyfile_name('credentials.json', scope)
client = gspread.authorize(creds)
sheet = client.open_by_key("1QQzKXtzvD4Tsj-qrF13aXYJl9Kznozx3BcPY9Tg2uEg").sheet1
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
