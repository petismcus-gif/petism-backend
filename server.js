require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { router: supplierRouter } = require("./supplier-adapters");

const app = express();
app.use(cors());
app.use(express.json());

// Health check — Railway uses this to confirm the service is alive
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "petism-backend" });
});

// Supplier forwarding routes (POST /orders/:orderId/forward etc.)
// NOTE: supplier-adapters.js expects req.order to already be loaded by
// middleware — wire that up once the Supabase client is in place.
app.use("/", supplierRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Petism backend listening on port ${PORT}`);
});
