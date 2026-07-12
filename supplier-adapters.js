/**
 * Petism — Supplier Integration Layer
 * ------------------------------------
 * Implements the SupplierAdapter interface from petism-backend-spec.md.
 * Each supplier gets its own adapter; the order service only talks to
 * the shared interface, so swapping/adding suppliers never touches
 * checkout logic.
 *
 * SETUP REQUIRED BEFORE THIS WORKS:
 * 1. Sign up at spocket.co, go to Settings → Developer/API to get SPOCKET_API_KEY.
 *    Spocket's public docs don't expose full REST reference outside the
 *    dashboard — confirm the exact base URL and endpoint paths shown in
 *    YOUR dashboard's API section, since these can differ by plan tier.
 * 2. Same for TopDawg — API access is granted per-account under their
 *    dropshipping plan; get TOPDAWG_API_KEY from their partner dashboard.
 * 3. Set both as environment variables (never hardcode keys).
 */

const express = require("express");
const router = express.Router();

// ---------- Shared adapter interface ----------
// interface SupplierAdapter {
//   name: string
//   createOrder(orderGroup): Promise<{ supplierOrderRef, estimatedShipDate }>
//   getTracking(supplierOrderRef): Promise<{ status, trackingNumber, carrier }>
// }

// ---------- Spocket Adapter ----------
class SpocketAdapter {
  constructor(apiKey) {
    this.name = "Spocket";
    this.apiKey = apiKey;
    this.baseUrl = "https://api.spocket.co/v1"; // confirm against your dashboard docs
  }

  async createOrder(orderGroup) {
    const { shippingAddress, items } = orderGroup;
    const payload = {
      order: {
        line_items: items.map((i) => ({
          supplier_sku: i.supplier_sku,
          quantity: i.qty,
        })),
        shipping_address: {
          name: shippingAddress.name,
          address1: shippingAddress.address,
          city: shippingAddress.city,
          zip: shippingAddress.zip,
          country: shippingAddress.country || "US",
        },
      },
    };

    const res = await fetch(`${this.baseUrl}/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Spocket order creation failed (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return {
      supplierOrderRef: data.order?.id,
      estimatedShipDate: data.order?.estimated_ship_date,
    };
  }

  async getTracking(supplierOrderRef) {
    const res = await fetch(`${this.baseUrl}/orders/${supplierOrderRef}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`Spocket tracking lookup failed (${res.status})`);
    const data = await res.json();
    return {
      status: data.order?.status,
      trackingNumber: data.order?.tracking_number,
      carrier: data.order?.carrier,
    };
  }
}

// ---------- TopDawg Adapter (poll-based, no webhooks) ----------
class TopDawgAdapter {
  constructor(apiKey) {
    this.name = "TopDawg";
    this.apiKey = apiKey;
    this.baseUrl = "https://api.topdawg.com/v2"; // confirm against your partner docs
  }

  async createOrder(orderGroup) {
    const { shippingAddress, items } = orderGroup;
    const payload = {
      items: items.map((i) => ({ sku: i.supplier_sku, qty: i.qty })),
      ship_to: shippingAddress,
    };

    const res = await fetch(`${this.baseUrl}/dropship/orders`, {
      method: "POST",
      headers: {
        "X-API-Key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`TopDawg order creation failed (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return {
      supplierOrderRef: data.orderId,
      estimatedShipDate: data.estShipDate,
    };
  }

  async getTracking(supplierOrderRef) {
    const res = await fetch(`${this.baseUrl}/dropship/orders/${supplierOrderRef}`, {
      headers: { "X-API-Key": this.apiKey },
    });
    if (!res.ok) throw new Error(`TopDawg tracking lookup failed (${res.status})`);
    const data = await res.json();
    return {
      status: data.status,
      trackingNumber: data.tracking?.number,
      carrier: data.tracking?.carrier,
    };
  }
}

// ---------- Adapter registry ----------
const adapters = {
  spocket: new SpocketAdapter(process.env.SPOCKET_API_KEY),
  topdawg: new TopDawgAdapter(process.env.TOPDAWG_API_KEY),
};

/**
 * Splits a paid order's line items by supplier, forwards each group
 * to the right adapter, and returns per-supplier results. Partial
 * failure (one supplier succeeds, one fails) is possible — caller
 * should persist per-item status rather than treating the whole
 * order as pass/fail.
 */
async function forwardOrderToSuppliers(order) {
  const bySupplier = {};
  for (const item of order.items) {
    const key = item.supplier_key; // e.g. "spocket" | "topdawg"
    if (!bySupplier[key]) bySupplier[key] = [];
    bySupplier[key].push(item);
  }

  const results = await Promise.allSettled(
    Object.entries(bySupplier).map(async ([supplierKey, items]) => {
      const adapter = adapters[supplierKey];
      if (!adapter) throw new Error(`No adapter registered for ${supplierKey}`);
      const result = await adapter.createOrder({
        shippingAddress: order.shippingAddress,
        items,
      });
      return { supplierKey, items: items.map((i) => i.id), ...result };
    })
  );

  return results.map((r, i) => {
    const supplierKey = Object.keys(bySupplier)[i];
    if (r.status === "fulfilled") {
      return { supplierKey, ok: true, ...r.value };
    }
    return { supplierKey, ok: false, error: r.reason.message };
  });
}

// ---------- Express route: called after Stripe payment succeeds ----------
router.post("/orders/:orderId/forward", async (req, res) => {
  try {
    const order = req.order; // assume middleware loaded the order + items from DB
    const results = await forwardOrderToSuppliers(order);

    // Persist per-supplier outcome onto order_items here (DB call omitted).
    const anyFailed = results.some((r) => !r.ok);
    res.status(anyFailed ? 207 : 200).json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Polling job for TopDawg tracking (runs every 30 min via cron) ----------
async function pollTopDawgTracking(openOrderItems) {
  for (const item of openOrderItems) {
    try {
      const tracking = await adapters.topdawg.getTracking(item.supplier_order_ref);
      // Update order_items.fulfillment_status, tracking_number, carrier in DB here.
      if (tracking.trackingNumber) {
        // Trigger customer "shipped" notification.
      }
    } catch (err) {
      console.error(`Tracking poll failed for ${item.supplier_order_ref}:`, err.message);
    }
  }
}

module.exports = { router, forwardOrderToSuppliers, pollTopDawgTracking, adapters };
