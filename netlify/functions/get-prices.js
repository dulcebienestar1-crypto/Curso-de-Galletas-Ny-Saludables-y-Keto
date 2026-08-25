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

// Nombre EXACTO del producto — la única oferta de la que esta función
// tiene permitido leer un precio. Si en algún momento cambias el nombre
// del producto en Tiendanube, debes actualizarlo aquí también, o la
// función dejará de encontrarlo a propósito (en vez de leer el precio
// equivocado de otro producto).
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

// Normaliza texto para comparar nombres de producto sin que espacios
// dobles, tildes raras de HTML o mayúsculas/minúsculas den un falso "no coincide".
function normalize(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

// Busca el nombre EXACTO del producto directamente en el HTML original
// (permitiendo etiquetas o espacios de más entre palabras, por si el
// nombre queda partido en varias líneas de HTML) y devuelve la
// posición donde empieza, en el HTML ORIGINAL — para poder buscar el
// precio a partir de ahí en el mismo string. Devuelve null si esta
// página no es la del producto esperado.
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findProductNameIndex(html) {
  const words = normalize(EXPECTED_PRODUCT_NAME).split(" ").map(escapeRegex);
  const pattern = new RegExp(words.join("[\\s\\S]{0,30}"), "i");
  const match = html.match(pattern);
  return match ? match.index : null;
}

// Intenta extraer {old, current} de la marca de datos estructurados
// (JSON-LD Product/Offer) que Tiendanube suele incluir para SEO.
// Solo se acepta si el "name" del producto en ese mismo bloque coincide
// exactamente con EXPECTED_PRODUCT_NAME.
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
    } catch (_) {
      // este bloque no era JSON válido — seguimos con el siguiente
    }
  }
  return null;
}

// Intenta extraer el precio de las etiquetas Open Graph de producto
// (<meta property="product:price:amount" ...>). Solo se usa si ya
// confirmamos por fuera (ver fetchPrice) que la página es del producto
// correcto — og:title también se valida como capa extra.
function fromOpenGraph(html) {
  const titleMatch = html.match(/property="og:title"\s+content="([^"]*)"/);
  if (!titleMatch || normalize(titleMatch[1]).indexOf(normalize(EXPECTED_PRODUCT_NAME)) === -1) {
    return null;
  }
  const m = html.match(/property="product:price:amount"\s+content="([\d.,]+)"/);
  if (!m) return null;
  return { current: parseMoney(m[1]), old: null, source: "open-graph" };
}

// Último recurso: busca el patrón visible "$viejo $nuevo" tal como
// aparece en la vitrina de Tiendanube (precio tachado seguido del
// precio con descuento). Como ya confirmamos (en fetchPrice) que el
// nombre exacto del producto está en esta página, buscamos DESDE ahí
// hacia adelante en todo el resto del documento y tomamos los dos
// primeros precios que aparezcan — el precio principal del producto
// siempre se muestra antes que cualquier sección de "productos
// relacionados" o "también te puede interesar" al final de la página.
function fromVisibleText(html, productNameIndex) {
  const relevantHtml = html.slice(productNameIndex);

  const pricePattern = /\$\s?([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?)/g;
  const matches = [...relevantHtml.matchAll(pricePattern)].map((m) => parseMoney(m[1]));
  const plausible = matches.filter((n) => n > 1000 || (n > 1 && n < 100000));
  if (plausible.length >= 2) {
    return { current: plausible[1], old: plausible[0], source: "text-fallback" };
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

  // Paso obligatorio: confirmar que esta página SÍ es la del producto
  // exacto. Si no aparece el nombre completo, nos detenemos aquí mismo
  // — nunca seguimos adivinando con otro precio de la página.
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
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: false,
        error: String(err && err.message ? err.message : err),
      }),
    };
  }
};
