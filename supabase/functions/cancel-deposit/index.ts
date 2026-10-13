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

    // 1. Ambil transaksi
    const { data: trx } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', transaction_id)
      .eq('user_id', user.id)
      .single();

    if (!trx) throw new Error('Transaksi tidak ditemukan');
    if (trx.status !== 'pending') {
      throw new Error('Hanya transaksi pending yang bisa dibatalkan');
    }

    // 2. Panggil AustinPay cancel
    const austinRes = await fetch(
      `${Deno.env.get('AUSTINPAY_BASE_URL')}/api/deposit/cancel/${trx.austinpay_trx_id}`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${Deno.env.get('AUSTINPAY_API_KEY')}` }
      }
    );

    if (!austinRes.ok) {
      const errData = await austinRes.json();
      throw new Error(errData.message || 'Gagal membatalkan di AustinPay');
    }

    // 3. Update status di DB
    await supabase
      .from('transactions')
      .update({ status: 'Dibatalkan' })
      .eq('id', transaction_id);

    return new Response(JSON.stringify({
      success: true,
      message: 'Transaksi dibatalkan'
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
