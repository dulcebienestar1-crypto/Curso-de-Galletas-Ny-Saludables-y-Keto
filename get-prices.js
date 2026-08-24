// netlify/functions/get-prices.js
//
// Esta función corre en el SERVIDOR de Netlify (no en el navegador del
// visitante), así que no choca con el bloqueo de CORS que tienen los
// navegadores. Su único trabajo es:
//   1. Entrar a las dos páginas oficiales de compra del curso (Colombia y
//      versión internacional en USD).
//   2. Leer el precio que esa página está mostrando en este momento para
//      esta oferta.
//   3. Devolverlo tal cual a la landing — sin convertir monedas, sin tasas
//      externas, sin inventar ni calcular nada más allá del % de
//      descuento (que es aritmética simple sobre los dos precios reales
//      encontrados en la misma página, no una conversión).
//
// Si tú cambias el precio, el descuento o la oferta en Tiendanube, la
// próxima vez que alguien abra la landing, esta función lee el valor
// nuevo automáticamente. No hay ningún precio guardado a mano en el código.

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

// Intenta extraer {old, current} de la marca de datos estructurados
// (JSON-LD Product/Offer) que Tiendanube suele incluir para SEO.
// Esta es la fuente MÁS confiable cuando está presente.
function fromJsonLd(html) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  for (const block of blocks) {
    try {
      const data = JSON.parse(block[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const offer = item.offers || item?.["@graph"]?.find((g) => g.offers)?.offers;
        if (offer && offer.price) {
          return { current: Number(offer.price), old: null, source: "json-ld" };
        }
      }
    } catch (_) {
      // este bloque no era JSON válido — seguimos con el siguiente
    }
  }
  return null;
}

// Intenta extraer el precio de las etiquetas Open Graph de producto
// (<meta property="product:price:amount" ...>), otra fuente confiable.
function fromOpenGraph(html) {
  const m = html.match(/property="product:price:amount"\s+content="([\d.,]+)"/);
  if (!m) return null;
  return { current: parseMoney(m[1]), old: null, source: "open-graph" };
}

// Último recurso: busca el patrón visible "$viejo $nuevo" tal como
// aparece en la vitrina de Tiendanube (precio tachado seguido del
// precio con descuento). Menos robusto: si la plantilla de la tienda
// cambia de diseño, esto es lo primero que podría dejar de funcionar.
function fromVisibleText(html, title_hint) {
  const pricePattern = /\$\s?([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?)/g;
  const matches = [...html.matchAll(pricePattern)].map((m) => parseMoney(m[1]));
  const plausible = matches.filter((n) => n > 1000 || (n > 1 && n < 100000));
  if (plausible.length >= 2) {
    return { current: plausible[plausible.length - 1], old: plausible[plausible.length - 2], source: "text-fallback" };
  }
  if (plausible.length === 1) {
    return { current: plausible[0], old: null, source: "text-fallback-single" };
  }
  return null;
}

function parseMoney(raw) {
  // Soporta "260.000" (miles con punto) y "84.54" (decimales con punto)
  const cleaned = raw.replace(/,/g, "");
  const parts = cleaned.split(".");
  if (parts.length > 1 && parts[parts.length - 1].length === 3) {
    // el último grupo de 3 dígitos es separador de miles, no decimales
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

  const result = fromJsonLd(html) || fromOpenGraph(html) || fromVisibleText(html);
  if (!result) throw new Error(`No se encontró un precio reconocible en ${url}`);

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
  };
}

exports.handler = async function () {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=300", // 5 min de caché — no es un valor de precio, es solo caché de red
  };

  try {
    const [cop, usd] = await Promise.all([
      fetchPrice("cop", SOURCES.cop),
      fetchPrice("usd", SOURCES.usd),
    ]);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        fetchedAt: new Date().toISOString(),
        cop,
        usd,
      }),
    };
  } catch (err) {
    return {
      statusCode: 200, // 200 a propósito: el frontend decide cómo degradar, no lo tratamos como fallo duro de red
      headers,
      body: JSON.stringify({
        ok: false,
        error: String(err && err.message ? err.message : err),
      }),
    };
  }
};
