import express from 'express';
import axios from 'axios';
import https from 'https';
import forge from 'node-forge';

const app = express();
app.use(express.json());

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-proxy-secret');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Variáveis de ambiente ────────────────────────────────────────────────────
const PIX_CERT_BASE64   = process.env.PIX_CERT_BASE64 || '';
const PIX_CERT_PASSWORD = process.env.PIX_CERT_PASSWORD || '';
const PIX_CLIENT_ID     = process.env.PIX_CLIENT_ID || '';
const PIX_CLIENT_SECRET = process.env.PIX_CLIENT_SECRET || '';
const PIX_PROXY_SECRET  = process.env.PIX_PROXY_SECRET || '';

// IMPORTANTE:
// No Railway, garanta que exista BASE44_WEBHOOK_URL com a URL correta.
// Se quiser manter compatibilidade com nome antigo, deixei fallback também.
const BASE44_WEBHOOK_URL =
  process.env.BASE44_WEBHOOK_URL ||
  process.env.URL_DE_WEBHOOK_BASE44 ||
  '';

// Chave Pix pagadora da conta Efí
const CHAVE_PIX_PAGADOR = 'c46897e1-3a12-478a-9b47-0e529b33b1ee';

// ─── Efí Produção ─────────────────────────────────────────────────────────────
const EFI_BASE_URL = 'https://pix.api.efipay.com.br';
const EFI_TOKEN_URL = `${EFI_BASE_URL}/oauth/token`;
const EFI_COB_URL = `${EFI_BASE_URL}/v2/cob`;
const EFI_EXTRATO_URL = `${EFI_BASE_URL}/v2/pix`;

app.get('/', (req, res) => {
  res.json({ status: 'Proxy CrediUnião PIX online' });
});

// ─── Segurança interna do proxy ───────────────────────────────────────────────
function validarSegredo(req, res, next) {
  const headerDireto = req.headers['x-proxy-secret'];
  const authHeader = req.headers['authorization'];
  const bearer = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  const segredo = headerDireto || bearer;

  if (!segredo || segredo !== PIX_PROXY_SECRET) {
    return res.status(401).json({ erro: 'Acesso não autorizado.' });
  }

  next();
}

// ─── Criação do agent com certificado P12 ─────────────────────────────────────
function criarAgent() {
  if (!PIX_CERT_BASE64) throw new Error('PIX_CERT_BASE64 não definido.');

  const p12Base64 = PIX_CERT_BASE64.replace(/\s+/g, '');
  const p12Der = Buffer.from(p12Base64, 'base64').toString('binary');
  const p12Asn1 = forge.asn1.fromDer(p12Der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, PIX_CERT_PASSWORD || '');

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certPem = forge.pki.certificateToPem(
    certBags[forge.pki.oids.certBag][0].cert
  );

  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const keyPem = forge.pki.privateKeyToPem(
    keyBags[forge.pki.oids.pkcs8ShroudedKeyBag][0].key
  );

  return new https.Agent({
    cert: certPem,
    key: keyPem,
    rejectUnauthorized: true,
  });
}

// ─── Token OAuth Efí ──────────────────────────────────────────────────────────
async function obterToken(agent) {
  const credencial = Buffer.from(`${PIX_CLIENT_ID}:${PIX_CLIENT_SECRET}`).toString('base64');

  const resposta = await axios.post(
    EFI_TOKEN_URL,
    'grant_type=client_credentials',
    {
      httpsAgent: agent,
      headers: {
        Authorization: `Basic ${credencial}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  return resposta.data.access_token;
}

// ─── Gerar cobrança PIX ───────────────────────────────────────────────────────
async function handleGerarPix(req, res) {
  try {
    const dados = req.body.payload || req.body;
    const valor = dados?.valor?.original || dados?.valor;
    const descricao =
      dados?.solicitacaoPagador ||
      dados?.descricao ||
      'Cobrança CrediUnião';

    if (!valor) {
      return res.status(400).json({ erro: 'Campo "valor" é obrigatório.' });
    }

    const agent = criarAgent();
    const token = await obterToken(agent);

    const payload = {
      calendario: { expiracao: 3600 },
      valor: { original: parseFloat(valor).toFixed(2) },
      chave: CHAVE_PIX_PAGADOR,
      solicitacaoPagador: descricao,
    };

    const resposta = await axios.post(EFI_COB_URL, payload, {
      httpsAgent: agent,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    return res.json(resposta.data);
  } catch (erro) {
    console.error('[ERRO /pix]', erro?.response?.data || erro.message);
    return res.status(500).json({
      erro: 'Falha ao gerar cobrança PIX.',
      detalhe: erro?.response?.data || erro.message,
    });
  }
}

app.post('/pix', validarSegredo, handleGerarPix);
app.post('/gerar-pix', validarSegredo, handleGerarPix);

// ─── Pagar via Pix (enviar por chave ou QR Code) ─────────────────────────────
// Efí:
// - chave Pix: PUT /v3/gn/pix/:idEnvio
// - QR Code:   PUT /v2/gn/pix/:idEnvio/qrcode
app.post('/pagar-pix', validarSegredo, async (req, res) => {
  try {
    const { chave, valor, descricao, qrcode, pixCopiaECola } = req.body;

    const qrCodeFinal = qrcode || pixCopiaECola;
    const isQrCode = !!qrCodeFinal;

    if (!chave && !isQrCode) {
      return res.status(400).json({
        erro: 'Informe chave Pix ou QR Code.',
      });
    }

    if (!valor || Number(valor) <= 0) {
      return res.status(400).json({
        erro: 'Valor inválido.',
      });
    }

    const agent = criarAgent();
    const token = await obterToken(agent);

    // id único da operação
    const idEnvio = Date.now().toString();

    let url;
    let payload;

    if (isQrCode) {
      url = `${EFI_BASE_URL}/v2/gn/pix/${idEnvio}/qrcode`;
      payload = {
        pagador: {
          chave: CHAVE_PIX_PAGADOR,
        },
        pixCopiaECola: qrCodeFinal,
      };

      if (descricao) {
        payload.pagador.infoPagador = descricao;
      }
    } else {
      url = `${EFI_BASE_URL}/v3/gn/pix/${idEnvio}`;
      payload = {
        valor: Number(valor).toFixed(2),
        pagador: {
          chave: CHAVE_PIX_PAGADOR,
        },
        favorecido: {
          chave,
        },
      };

      if (descricao) {
        payload.pagador.infoPagador = descricao;
      }
    }

    console.log('[pagar-pix] enviando para Efí', {
      idEnvio,
      tipo: isQrCode ? 'qrcode' : 'chave',
      url,
      valor,
    });

    const resposta = await axios.put(url, payload, {
      httpsAgent: agent,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    return res.json({
      ok: true,
      idEnvio,
      tipo: isQrCode ? 'qrcode' : 'chave',
      data: resposta.data,
    });
  } catch (erro) {
    console.error('[ERRO /pagar-pix]', erro?.response?.data || erro.message);
    return res.status(500).json({
      erro: 'Falha ao enviar Pix.',
      detalhe: erro?.response?.data || erro.message,
    });
  }
});

// ─── Consultar envio Pix por idEnvio ──────────────────────────────────────────
// Efí recomenda consultar este endpoint antes de reenviar quando houver dúvida.
app.get('/consultar-envio-pix/:idEnvio', validarSegredo, async (req, res) => {
  try {
    const { idEnvio } = req.params;

    const agent = criarAgent();
    const token = await obterToken(agent);

    const resposta = await axios.get(
      `${EFI_BASE_URL}/v2/gn/pix/enviados/id-envio/${idEnvio}`,
      {
        httpsAgent: agent,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    return res.json(resposta.data);
  } catch (erro) {
    console.error('[ERRO /consultar-envio-pix]', erro?.response?.data || erro.message);
    return res.status(500).json({
      erro: 'Falha ao consultar envio Pix.',
      detalhe: erro?.response?.data || erro.message,
    });
  }
});

// ─── Consultar saldo ──────────────────────────────────────────────────────────
app.get('/saldo', validarSegredo, async (req, res) => {
  try {
    const agent = criarAgent();
    const token = await obterToken(agent);

    const resposta = await axios.get(`${EFI_BASE_URL}/v2/gn/saldo`, {
      httpsAgent: agent,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    return res.json(resposta.data);
  } catch (erro) {
    console.error('[ERRO /saldo]', erro?.response?.data || erro.message);
    return res.status(500).json({
      erro: 'Falha ao consultar saldo.',
      detalhe: erro?.response?.data || erro.message,
    });
  }
});

// ─── Extrato (Pix recebidos) ──────────────────────────────────────────────────
app.get('/extrato', validarSegredo, async (req, res) => {
  try {
    const { inicio, fim } = req.query;

    const agent = criarAgent();
    const token = await obterToken(agent);

    const params = {
      inicio: inicio || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      fim: fim || new Date().toISOString(),
    };

    const resposta = await axios.get(EFI_EXTRATO_URL, {
      httpsAgent: agent,
      headers: {
        Authorization: `Bearer ${token}`,
      },
      params,
    });

    return res.json(resposta.data);
  } catch (erro) {
    console.error('[ERRO /extrato]', erro?.response?.data || erro.message);
    return res.status(500).json({
      erro: 'Falha ao consultar extrato.',
      detalhe: erro?.response?.data || erro.message,
    });
  }
});

// ─── Consultar cobrança por txid ──────────────────────────────────────────────
app.get('/consultar-pix/:txid', validarSegredo, async (req, res) => {
  try {
    const { txid } = req.params;

    const agent = criarAgent();
    const token = await obterToken(agent);

    const resposta = await axios.get(`${EFI_COB_URL}/${txid}`, {
      httpsAgent: agent,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    return res.json(resposta.data);
  } catch (erro) {
    console.error('[ERRO /consultar-pix]', erro?.response?.data || erro.message);
    return res.status(500).json({
      erro: 'Falha ao consultar cobrança.',
      detalhe: erro?.response?.data || erro.message,
    });
  }
});

// ─── Buscar certificado CA da Efí ─────────────────────────────────────────────
app.get('/efi-ca-cert', async (req, res) => {
  try {
    const agent = criarAgent();

    const resposta = await axios.get(
      'https://pix.api.efipay.com.br/.well-known/pix.crt',
      {
        httpsAgent: agent,
        responseType: 'text',
        headers: { Accept: '*/*' },
      }
    );

    res.set('Content-Type', 'application/x-pem-file');
    res.set('Content-Disposition', 'attachment; filename="efi-ca.crt"');

    return res.send(resposta.data);
  } catch (erro) {
    console.error('[ERRO /efi-ca-cert]', erro?.response?.data || erro.message);
    return res.status(500).json({
      erro: 'Falha ao buscar certificado CA.',
      detalhe: erro?.response?.data || erro.message,
    });
  }
});

// ─── Webhook relay ────────────────────────────────────────────────────────────
app.get('/webhook/callback', (req, res) => {
  res.status(200).send('OK');
});

app.post('/webhook/callback', async (req, res) => {
  try {
    if (!BASE44_WEBHOOK_URL) {
      console.error('[WEBHOOK] BASE44_WEBHOOK_URL não configurado.');
      return res.status(500).json({
        erro: 'BASE44_WEBHOOK_URL não configurado.',
      });
    }

    console.log('[WEBHOOK] Recebido da Efí:', JSON.stringify(req.body));

    const resposta = await axios.post(BASE44_WEBHOOK_URL, req.body, {
      headers: { 'Content-Type': 'application/json' },
    });

    console.log('[WEBHOOK] Repassado ao Base44, status:', resposta.status);

    return res.status(200).json({ sucesso: true });
  } catch (erro) {
    console.error('[ERRO /webhook/callback]', erro?.response?.data || erro.message);
    return res.status(500).json({
      erro: 'Falha ao repassar webhook.',
      detalhe: erro?.response?.data || erro.message,
    });
  }
});

// ─── Registrar webhook Pix na Efí ─────────────────────────────────────────────
app.put('/webhook/:chave', validarSegredo, async (req, res) => {
  try {
    const { chave } = req.params;
    const { webhookUrl } = req.body;

    if (!webhookUrl) {
      return res.status(400).json({ erro: 'Campo "webhookUrl" é obrigatório.' });
    }

    const agent = criarAgent();
    const token = await obterToken(agent);

    const resposta = await axios.put(
      `${EFI_BASE_URL}/v2/webhook/${chave}`,
      { webhookUrl },
      {
        httpsAgent: agent,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'x-skip-mtls-checking': 'true',
        },
      }
    );

    return res.json({
      sucesso: true,
      status: resposta.status,
      data: resposta.data,
    });
  } catch (erro) {
    console.error('[ERRO /webhook]', erro?.response?.data || erro.message);
    return res.status(erro.response?.status || 500).json({
      erro: 'Falha ao registrar webhook.',
      detalhe: erro?.response?.data || erro.message,
    });
  }
});

// ─── Consultar webhook registrado ─────────────────────────────────────────────
app.get('/webhook/:chave', validarSegredo, async (req, res) => {
  try {
    const { chave } = req.params;

    const agent = criarAgent();
    const token = await obterToken(agent);

    const resposta = await axios.get(`${EFI_BASE_URL}/v2/webhook/${chave}`, {
      httpsAgent: agent,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    return res.json(resposta.data);
  } catch (erro) {
    console.error('[ERRO GET /webhook]', erro?.response?.data || erro.message);
    return res.status(erro.response?.status || 500).json({
      erro: 'Falha ao consultar webhook.',
      detalhe: erro?.response?.data || erro.message,
    });
  }
});

// ─── Inicialização ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy PIX CrediUnião rodando na porta ${PORT}`);
});
