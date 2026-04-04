import express from 'express';
import axios from 'axios';
import https from 'https';

const app = express();
app.use(express.json());

// ─── Variáveis de ambiente ───────────────────────────────────────────────────
const PIX_CERT_BASE64   = process.env.PIX_CERT_BASE64   || '';
const PIX_CERT_PASSWORD = process.env.PIX_CERT_PASSWORD || '';
const PIX_CLIENT_ID     = process.env.PIX_CLIENT_ID     || '';
const PIX_CLIENT_SECRET = process.env.PIX_CLIENT_SECRET || '';
const PIX_PROXY_SECRET  = process.env.PIX_PROXY_SECRET  || '';

// ─── URLs da Efí ────────────────────────────────────────────────────────────
const EFI_BASE_URL  = 'https://pix-h.api.efipay.com.br'; // homologação
// const EFI_BASE_URL = 'https://pix.api.efipay.com.br'; // produção (trocar depois)

const EFI_TOKEN_URL = `${EFI_BASE_URL}/oauth/token`;
const EFI_COB_URL   = `${EFI_BASE_URL}/v2/cob`;

// ─── Rota de health check ────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Proxy CrediUnião PIX online' });
});

// ─── Middleware: valida segredo do proxy ─────────────────────────────────────
function validarSegredo(req, res, next) {
  const headerDireto = req.headers['x-proxy-secret'];
  const authHeader   = req.headers['authorization'];
  const bearer       = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;
  const segredo = headerDireto || bearer;
  if (!segredo || segredo !== PIX_PROXY_SECRET) {
    return res.status(401).json({ erro: 'Acesso não autorizado.' });
  }
  next();
}

// ─── Monta o https.Agent com o certificado .p12 ──────────────────────────────
function criarAgent() {
  if (!PIX_CERT_BASE64) {
    throw new Error('PIX_CERT_BASE64 não definido nas variáveis de ambiente.');
  }

  // Remove espaços/quebras de linha do Base64 antes de decodificar
  const certBuffer = Buffer.from(PIX_CERT_BASE64.replace(/\s+/g, ''), 'base64');

  // Monta o agente — só inclui passphrase se tiver valor
  const agentOptions = {
    pfx: certBuffer,
    rejectUnauthorized: true,
  };

  if (PIX_CERT_PASSWORD) {
    agentOptions.passphrase = PIX_CERT_PASSWORD;
  }

  return new https.Agent(agentOptions);
}

// ─── Obtém token OAuth da Efí ─────────────────────────────────────────────────
async function obterToken(agent) {
  const credencial = Buffer.from(`${PIX_CLIENT_ID}:${PIX_CLIENT_SECRET}`).toString('base64');
  const resposta = await axios.post(
    EFI_TOKEN_URL,
    'grant_type=client_credentials',
    {
      httpsAgent: agent,
      headers: {
        'Authorization': `Basic ${credencial}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );
  return resposta.data.access_token;
}

// ─── Handler: gerar cobrança PIX ─────────────────────────────────────────────
async function handleGerarPix(req, res) {
  try {
    const dados     = req.body.payload || req.body;
    const valor     = dados?.valor?.original || dados?.valor;
    const descricao = dados?.solicitacaoPagador || dados?.descricao || 'Cobrança CrediUnião';
    const txid      = req.body.txid || dados?.txid;

    if (!valor) {
      return res.status(400).json({ erro: 'Campo "valor" é obrigatório.' });
    }

    const agent = criarAgent();
    const token = await obterToken(agent);

    const payload = {
      calendario: { expiracao: 3600 },
      valor: { original: parseFloat(valor).toFixed(2) },
      chave: 'c46897e1-3a12-478a-9b47-0e529b33b1ee',
      solicitacaoPagador: descricao,
    };

    let url    = EFI_COB_URL;
    let metodo = 'post';
    if (txid) {
      url    = `${EFI_COB_URL}/${txid}`;
      metodo = 'put';
    }

    const resposta = await axios({
      method: metodo,
      url,
      data: payload,
      httpsAgent: agent,
      headers: {
        'Authorization': `Bearer ${token}`,
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

// Aceita nos dois endpoints
app.post('/pix',       validarSegredo, handleGerarPix);
app.post('/gerar-pix', validarSegredo, handleGerarPix);

// ─── Rota: consultar cobrança PIX por txid ────────────────────────────────────
app.get('/consultar-pix/:txid', validarSegredo, async (req, res) => {
  try {
    const { txid } = req.params;
    const agent = criarAgent();
    const token = await obterToken(agent);
    const resposta = await axios.get(`${EFI_COB_URL}/${txid}`, {
      httpsAgent: agent,
      headers: { 'Authorization': `Bearer ${token}` },
    });
    return res.json(resposta.data);
  } catch (erro) {
    console.error('[ERRO /consultar-pix]', erro?.response?.data || erro.message);
    return res.status(500).json({
      erro: 'Falha ao consultar cobrança PIX.',
      detalhe: erro?.response?.data || erro.message,
    });
  }
});

// ─── Porta dinâmica Railway ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy PIX CrediUnião rodando na porta ${PORT}`);
});
