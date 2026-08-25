// netlify/functions/get-prices.js
//
// Esta función corre en el SERVIDOR de Netlify (no en el navegador del
// visitante), así que no choca con el bloqueo de CORS que tienen los
// navegadores. Su único trabajo es:
//   1. Entrar a las dos páginas oficiales de compra del curso (Colombia y
//      versión internacional en USD).
//   2. CONFIRMAR que la página corresponde exactamente al producto
//      "CURSO VIRTUAL DE GALLETAS LEVAIN SALUDABLES Y KETO LEVAIN ESTILO NY"
//      — si el nombre exacto no aparece en la página, la función se
//      detiene y no devuelve ningún precio (nunca adivina ni toma el
//      precio de otro producto de la tienda).
//   3. Leer el precio que esa página está mostrando en este momento para
//      ESE producto exacto.
//   4. Devolverlo tal cual a la landing — sin convertir monedas, sin tasas
//      externas, sin inventar ni calcular nada más allá del % de
//      descuento (aritmética simple sobre los dos precios reales
//      encontrados junto al nombre del producto, no una conversión).
//
// Si tú cambias el precio, el descuento o la oferta en Tiendanube, la
// próxima vez que alguien abra la landing, esta función lee el valor
// nuevo automáticamente. No hay ningún precio guardado a mano en el código.

const EXPECTED_PRODUCT_NAME = "CURSO VIRTUAL DE GALLETAS LEVAIN SALUDABLES Y KETO LEVAIN ESTILO NY";

const SOURCES = {
  cop: {
    url: "https://dulcebienestaracademy.com/productos/curso-virtual-de-galletas-levain-saludables-y-keto-levain-estilo-ny-3h8m6/",
    currency: "COP",
  },
  usd: {
    url: "https://dulcebienestaracademy.com/us/productos/curso-virtual-de-galletas-levain-saludables-y-keto-levain-estilo-ny-3h8m6/",
    currency: "USD",
  },
};

function normalize(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findProductNameIndex(html) {
  const words = normalize(EXPECTED_PRODUCT_NAME).split(" ").map(escapeRegex);
  const pattern = new RegExp(words.join("[\\s\\S]{0,30}"), "i");
  const match = html.match(pattern);
  return match ? match.index : null;
}

function fromJsonLd(html) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  for (const block of blocks) {
    try {
      const data = JSON.parse(block[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const productName = item.name || item?.["@graph"]?.find((g) => g.name)?.name;
        if (!productName || normalize(productName) !== normalize(EXPECTED_PRODUCT_NAME)) continue;
        const offer = item.offers || item?.["@graph"]?.find((g) => g.offers)?.offers;
        if (offer && offer.price) {
          return { current: Number(offer.price), old: null, source: "json-ld" };
        }
      }
    } catch (_) {}
  }
  return null;
}

function fromOpenGraph(html) {
  const titleMatch = html.match(/property="og:title"\s+content="([^"]*)"/);
  if (!titleMatch || normalize(titleMatch[1]).indexOf(normalize(EXPECTED_PRODUCT_NAME)) === -1) {
    return null;
  }
  const m = html.match(/property="product:price:amount"\s+content="([\d.,]+)"/);
  if (!m) return null;
  return { current: parseMoney(m[1]), old: null, source: "open-graph" };
}

function fromVisibleText(html, productNameIndex) {
  const relevantHtml = html.slice(productNameIndex, productNameIndex + 15000);
  const pricePattern = /\$\s?([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?)/;

  const delMatch = relevantHtml.match(/<del[^>]*>([\s\S]{0,60}?)<\/del>/i);
  if (delMatch) {
    const oldPriceMatch = delMatch[1].match(pricePattern);
    if (oldPriceMatch) {
      const afterDel = relevantHtml.slice(delMatch.index + delMatch[0].length, delMatch.index + delMatch[0].length + 300);
      const currentPriceMatch = afterDel.match(pricePattern);
      if (currentPriceMatch) {
        const old = parseMoney(oldPriceMatch[1]);
        const current = parseMoney(currentPriceMatch[1]);
        if (old > 0 && current > 0) {
          return { current, old, source: "del-tag" };
        }
      }
    }
  }

  const pricePatternGlobal = /\$\s?([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?)/g;
  const matches = [...relevantHtml.matchAll(pricePatternGlobal)].map((m) => parseMoney(m[1]));
  const plausible = matches.filter((n) => n > 1000 || (n > 1 && n < 100000));

  const distinct = [];
  for (const n of plausible) {
    if (distinct.length === 0 || distinct[distinct.length - 1] !== n) distinct.push(n);
  }
  const uniqueValues = [...new Set(distinct)];

  if (uniqueValues.length >= 2) {
    let [old, current] = uniqueValues;
    if (current > old) [old, current] = [current, old];
    return { current, old, source: "text-fallback-distinct", allPricesFound: plausible };
  }
  if (uniqueValues.length === 1) {
    return { current: uniqueValues[0], old: null, source: "text-fallback-single", allPricesFound: plausible };
  }
  return null;
}

function parseMoney(raw) {
  const cleaned = raw.replace(/,/g, "");
  const parts = cleaned.split(".");
  if (parts.length > 1 && parts[parts.length - 1].length === 3) {
    return Number(parts.join(""));
  }
  return Number(cleaned);
}

async function fetchPrice(key, { url, currency }) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; DulceBienestarPriceBot/1.0)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} al leer ${url}`);
  const html = await res.text();

  const productNameIndex = findProductNameIndex(html);
  if (productNameIndex === null) {
    throw new Error(
      `La página ${url} no contiene el producto exacto "${EXPECTED_PRODUCT_NAME}" — no se leyó ningún precio por seguridad.`
    );
  }

  const result = fromJsonLd(html) || fromOpenGraph(html) || fromVisibleText(html, productNameIndex);
  if (!result) throw new Error(`Se encontró el producto en ${url}, pero no un precio reconocible cerca de su nombre.`);

  const discountPct =
    result.old && result.old > result.current
      ? Math.round(((result.old - result.current) / result.old) * 100)
      : null;

  return {
    currency,
    current: result.current,
    old: result.old,
    discountPct,
    source: result.source,
    verifiedProductName: EXPECTED_PRODUCT_NAME,
  };
}

exports.handler = async function () {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=300",
  };

  try {
    const [cop, usd] = await Promise.all([
      fetchPrice("cop", SOURCES.cop),
      fetchPrice("usd", SOURCES.usd),
    ]);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, fetchedAt: new Date().toISOString(), cop, usd }),
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }),
    };
  }
};
