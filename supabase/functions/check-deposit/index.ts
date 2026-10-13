import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing authorization');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const token = authHeader.replace('Bearer ', '');
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) throw new Error('Invalid token');

    const { transaction_id } = await req.json();
    if (!transaction_id) throw new Error('Missing transaction_id');

    // 1. Ambil transaksi dari DB
    const { data: trx, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', transaction_id)
      .eq('user_id', user.id)
      .single();

    if (error || !trx) throw new Error('Transaksi tidak ditemukan');

    // 2. Kalau sudah final status, tidak perlu cek ke AustinPay lagi
    if (['Diproses', 'Dibatalkan', 'Expired'].includes(trx.status)) {
      return new Response(JSON.stringify({
        success: true,
        transaction: trx,
        message: 'Status final'
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 3. Cek ke AustinPay
    const austinRes = await fetch(
      `${Deno.env.get('AUSTINPAY_BASE_URL')}/api/deposit/check/${trx.austinpay_trx_id}`,
      {
        headers: { 'Authorization': `Bearer ${Deno.env.get('AUSTINPAY_API_KEY')}` }
      }
    );

    const austinData = await austinRes.json();

    // 4. Update status jika berubah
    let newStatus = trx.status;
    if (austinData.status === 'success' || austinData.status === 'paid') {
      newStatus = 'Diproses';
    } else if (austinData.status === 'expired') {
      newStatus = 'Expired';
    } else if (austinData.status === 'cancelled' || austinData.status === 'canceled') {
      newStatus = 'Dibatalkan';
    }

    if (newStatus !== trx.status) {
      const updateData: any = { status: newStatus };
      if (newStatus === 'Diproses') updateData.paid_at = new Date().toISOString();

      await supabase
        .from('transactions')
        .update(updateData)
        .eq('id', transaction_id);
    }

    // 5. Return data terbaru
    const { data: updatedTrx } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', transaction_id)
      .single();

    return new Response(JSON.stringify({
      success: true,
      transaction: updatedTrx
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
