const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// GET /api/products — real product catalog from Supabase
router.get("/api/products", async (req, res) => {
  const { data, error } = await supabase
    .from("products")
    .select("*, suppliers(name)")
    .order("created_at", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ products: data });
});

// GET /api/orders — most recent orders (no auth yet, so this returns everyone's —
// fine for testing, but add a customer filter before real customers use this)
router.get("/api/orders", async (req, res) => {
  const { data, error } = await supabase
    .from("orders")
    .select("*, order_items(*)")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ orders: data });
});

// POST /api/orders — create an order + its items from a checkout submission
router.post("/api/orders", async (req, res) => {
  const { customerName, customerEmail, shippingAddress, items, subtotal, total } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ error: "Order must include at least one item" });
  }

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .insert({
      customer_name: customerName,
      customer_email: customerEmail,
      shipping_address: shippingAddress,
      subtotal,
      total,
      status: "paid",
    })
    .select()
    .single();

  if (orderError) return res.status(500).json({ error: orderError.message });

  const orderItems = items.map((item) => ({
    order_id: order.id,
    product_id: item.id,
    supplier_id: item.supplier_id,
    qty: item.qty,
    unit_price: item.price,
  }));

  const { error: itemsError } = await supabase.from("order_items").insert(orderItems);
  if (itemsError) return res.status(500).json({ error: itemsError.message });

  res.status(201).json({ order });
});

module.exports = { router, supabase };
