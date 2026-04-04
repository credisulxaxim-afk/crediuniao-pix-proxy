import express from "express";
import fs from "fs";
import https from "https";
import axios from "axios";

const app = express();
app.use(express.json());

// Carrega certificado (Base64 vindo do Railway)
const certBuffer = Buffer.from(process.env.PIX_CERT_BASE64, "base64");

const httpsAgent = new https.Agent({
  pfx: certBuffer,
  passphrase: process.env.PIX_CERT_PASSWORD
});

app.post("/pix", async (req, res) => {
  try {
    const response = await axios.post(
      "https://pix-h.api.efipay.com.br/v2/cob",
      req.body,
      {
        httpsAgent,
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              ${process.env.PIX_CLIENT_ID}:${process.env.PIX_CLIENT_SECRET}
            ).toString("base64"),
          "Content-Type": "application/json"
        }
      }
    );

    res.json(response.data);
  } catch (err) {
    res.status(500).json({
      error: err.response?.data || err.message
    });
  }
});

app.get("/", (req, res) => {
  res.send("Proxy PIX rodando 🚀");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
});
