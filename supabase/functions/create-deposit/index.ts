import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // 1. Verifikasi user dari JWT
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing authorization header');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) throw new Error('Invalid token');

    // 2. Ambil body request
    const { product_id, product_name, harga, jumlah = 1 } = await req.json();

    if (!product_id || !harga) throw new Error('Missing product data');

    const totalAmount = harga * jumlah;
    const referenceId = `TRX-${Date.now()}-${user.id.substring(0, 8)}`;

    // 3. Panggil AustinPay API
    const austinRes = await fetch(`${Deno.env.get('AUSTINPAY_BASE_URL')}/api/deposit/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${Deno.env.get('AUSTINPAY_API_KEY')}`
      },
      body: JSON.stringify({
        amount: totalAmount,
        method: 'qris',
        reference_id: referenceId,
        customer_name: user.user_metadata?.name || 'Customer',
        customer_email: user.email
      })
    });

    const austinData = await austinRes.json();

    if (!austinRes.ok) {
      console.error('AustinPay error:', austinData);
      throw new Error(austinData.message || 'Gagal membuat QRIS');
    }

    // 4. Simpan ke database
    const { data: trx, error: dbError } = await supabase
      .from('transactions')
      .insert({
        user_id: user.id,
        product_id,
        product_name,
        harga,
        jumlah,
        austinpay_trx_id: austinData.transactionId || austinData.id,
        reference_id: referenceId,
        qr_string: austinData.qr_string,
        qr_image_url: austinData.qr_image_url,
        payment_method: 'qris',
        expired_at: austinData.expired_at,
        status: 'pending'
      })
      .select()
      .single();

    if (dbError) throw dbError;

    return new Response(JSON.stringify({
      success: true,
      transaction: trx
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Error:', error.message);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
