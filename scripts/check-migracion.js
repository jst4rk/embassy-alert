const fs = require("fs");
const path = require("path");

const url =
  "https://tramites.migracion.gob.pa/portal_migracion_digital/app/server/visas_consulares.php";

const passport = process.env.PASSPORT;
const caseNumber = process.env.CASE_NUMBER;

const statusPath = path.join(
  process.cwd(),
  "data",
  "migracion-status.json"
);

async function getStatus() {
  const body = new URLSearchParams({
    pasaporte: passport,
    caso: caseNumber,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(
      `Migration server returned HTTP ${response.status}`
    );
  }

  return response.text();
}

function decodeHtml(value) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function parseRows(html) {
  const rows = [];
  const rowRegex = /<tr>([\s\S]*?)<\/tr>/gi;

  for (const match of html.matchAll(rowRegex)) {
    const rowHtml = match[1];

    const cells = [
      ...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi),
    ].map((cell) =>
      decodeHtml(cell[1].replace(/<[^>]+>/g, " "))
    );

    if (cells.length !== 4) {
      continue;
    }

    rows.push({
      orden: cells[0],
      tarea: cells[1],
      fecha_inicio: cells[2],
      fecha_fin: cells[3],
    });
  }

  return rows;
}

function parseApplicant(html) {
  const getValue = (id) => {
    const regex = new RegExp(
      `<input[^>]*id="${id}"[^>]*value="([^"]*)"`,
      "i"
    );

    return html.match(regex)?.[1]?.trim() ?? "";
  };

  return {
    caso: getValue("caso"),
    tipo_tramite: getValue("tipo_tramite"),
    solicitante: getValue("solicitante"),
    pasaporte: getValue("pasaporte"),
    nacionalidad: getValue("nacionalidad"),
  };
}

function buildStatus(html) {
  return {
    checked_at: new Date().toISOString(),
    applicant: parseApplicant(html),
    rows: parseRows(html),
  };
}

function createNotification(previous, current) {
  if (!previous) {
    return `🔎 Migración Panamá

Caso: ${current.applicant.caso}
Solicitante: ${current.applicant.solicitante}

Estado inicial registrado.
Etapas encontradas: ${current.rows.length}`;
  }

  const messages = [];

  const previousRows = previous.rows ?? [];
  const currentRows = current.rows ?? [];

  if (currentRows.length > previousRows.length) {
    const newRows = currentRows.slice(previousRows.length);

    for (const row of newRows) {
      messages.push(
        `🆕 Nueva etapa

${row.orden}. ${row.tarea}
Inicio: ${row.fecha_inicio}
Finalización: ${row.fecha_fin || "Pendiente"}`
      );
    }
  }

  const previousByOrder = new Map(
    previousRows.map((row) => [row.orden, row])
  );

  for (const row of currentRows) {
    const oldRow = previousByOrder.get(row.orden);

    if (!oldRow) {
      continue;
    }

    if (oldRow.fecha_fin !== row.fecha_fin) {
      messages.push(
        `✅ Etapa actualizada

${row.orden}. ${row.tarea}
Fecha finalización:
${oldRow.fecha_fin || "Pendiente"} → ${row.fecha_fin || "Pendiente"}`
      );
    }
  }

  return messages.length
    ? `🚨 Migración Panamá — Caso ${current.applicant.caso}\n\n${messages.join("\n\n")}`
    : null;
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error("Telegram secrets are not configured.");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Telegram returned HTTP ${response.status}`
    );
  }
}

async function main() {
  if (!passport || !caseNumber) {
    throw new Error("Migration credentials are not configured.");
  }

  console.log("Checking migration status...");

  const html = await getStatus();
  const current = buildStatus(html);

  console.log(
    `Found ${current.rows.length} migration stages.`
  );

  let previous = null;

  if (fs.existsSync(statusPath)) {
    previous = JSON.parse(
      fs.readFileSync(statusPath, "utf8")
    );
  }

  const notification = createNotification(previous, current);

  if (notification) {
    console.log("Change detected. Sending Telegram notification...");
    await sendTelegram(notification);
  } else {
    console.log("No changes detected.");
  }

  fs.mkdirSync(path.dirname(statusPath), {
    recursive: true,
  });

  fs.writeFileSync(
    statusPath,
    JSON.stringify(current, null, 2) + "\n"
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
