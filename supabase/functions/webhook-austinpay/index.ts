import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  // Webhook tidak butuh CORS karena dipanggil server AustinPay
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const payload = await req.json();
    console.log('📥 Webhook received:', JSON.stringify(payload));

    // Struktur payload AustinPay bisa berbeda
    // Sesuaikan dengan dokumentasi AustinPay Anda
    const {
      transactionId,
      reference_id,
      status,
      amount,
      paid_at
    } = payload;

    if (!transactionId && !reference_id) {
      return new Response(JSON.stringify({ ok: false, error: 'No identifier' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Cari transaksi berdasarkan austinpay_trx_id atau reference_id
    let query = supabase.from('transactions').select('*');
    if (transactionId) query = query.eq('austinpay_trx_id', transactionId);
    else query = query.eq('reference_id', reference_id);

    const { data: trx } = await query.single();

    if (!trx) {
      console.warn('⚠️ Transaksi tidak ditemukan:', transactionId || reference_id);
      // Tetap return 200 agar AustinPay tidak retry
      return new Response(JSON.stringify({ ok: true, note: 'trx not found' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Tentukan status baru
    let newStatus = trx.status;
    if (status === 'success' || status === 'paid') newStatus = 'Diproses';
    else if (status === 'expired') newStatus = 'Expired';
    else if (status === 'cancelled' || status === 'canceled') newStatus = 'Dibatalkan';
    else if (status === 'failed') newStatus = 'Gagal';

    if (newStatus !== trx.status) {
      const updateData: any = { status: newStatus };
      if (newStatus === 'Diproses' && paid_at) updateData.paid_at = paid_at;
      else if (newStatus === 'Diproses') updateData.paid_at = new Date().toISOString();

      await supabase.from('transactions').update(updateData).eq('id', trx.id);
      console.log('✅ Status updated:', trx.id, '→', newStatus);
    }

    // WAJIB: Return 200 dalam 10 detik
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Webhook error:', error);
    // Tetap 200 agar tidak di-retry berkali-kali untuk error yang bukan transient
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});
