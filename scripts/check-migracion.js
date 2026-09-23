const fs = require("fs");
const path = require("path");

const URL =
  "https://tramites.migracion.gob.pa/portal_migracion_digital/app/server/visas_consulares.php";

const passport = process.env.PASSPORT;
const caseNumber = process.env.CASE_NUMBER;
const resendApiKey = process.env.RESEND_API_KEY;
const notificationEmail = process.env.NOTIFICATION_EMAIL;

const statusPath = path.join(
  process.cwd(),
  "data",
  "migracion-status.json"
);

async function getStatus() {
  const { execFile } = require("child_process");
  const { promisify } = require("util");

  const execFileAsync = promisify(execFile);

  const body = `pasaporte=${encodeURIComponent(
    passport
  )}&caso=${encodeURIComponent(caseNumber)}`;

  const { stdout } = await execFileAsync("curl", [
    "-sS",
    "-4",
    "-X",
    "POST",
    URL,
    "-H",
    "X-Requested-With: XMLHttpRequest",
    "-H",
    "Content-Type: application/x-www-form-urlencoded; charset=UTF-8",
    "--data",
    body,
  ]);

  return stdout;
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
    const cells = [
      ...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi),
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

function findChanges(previous, current) {
  if (!previous) {
    return {
      changed: true,
      changes: ["Initial status recorded."],
    };
  }

  const changes = [];

  const previousRows = previous.rows ?? [];
  const currentRows = current.rows ?? [];

  // Detect new rows
  if (currentRows.length > previousRows.length) {
    const newRows = currentRows.slice(previousRows.length);

    for (const row of newRows) {
      changes.push(
        `<strong>New stage: ${row.orden}. ${row.tarea}</strong><br>` +
        `Start: ${row.fecha_inicio}<br>` +
        `Completion: ${row.fecha_fin || "Pending"}`
      );
    }
  }

  // Detect changes to existing rows
  const previousByOrder = new Map(
    previousRows.map((row) => [row.orden, row])
  );

  for (const row of currentRows) {
    const oldRow = previousByOrder.get(row.orden);

    if (!oldRow) {
      continue;
    }

    if (oldRow.fecha_fin !== row.fecha_fin) {
      changes.push(
        `<strong>Stage updated: ${row.orden}. ${row.tarea}</strong><br>` +
        `Previous completion: ${oldRow.fecha_fin || "Pending"}<br>` +
        `New completion: ${row.fecha_fin || "Pending"}`
      );
    }

    if (oldRow.tarea !== row.tarea) {
      changes.push(
        `<strong>Stage changed: ${row.orden}</strong><br>` +
        `Previous: ${oldRow.tarea}<br>` +
        `New: ${row.tarea}`
      );
    }
  }

  return {
    changed: changes.length > 0,
    changes,
  };
}

async function sendEmail(current, changes) {
  const subject =
    `Migración Panamá - Caso ${current.applicant.caso} actualizado`;

  const html = `
    <h2>Migración Panamá</h2>

    <p>
      <strong>Caso:</strong>
      ${current.applicant.caso}
    </p>

    <p>
      <strong>Solicitante:</strong>
      ${current.applicant.solicitante}
    </p>

    <p>
      <strong>Tipo de trámite:</strong>
      ${current.applicant.tipo_tramite}
    </p>

    <hr>

    ${changes.map((change) => `<p>${change}</p>`).join("")}

    <hr>

    <h3>Estado actual</h3>

    <table border="1" cellpadding="6" cellspacing="0">
      <thead>
        <tr>
          <th>Orden</th>
          <th>Tarea</th>
          <th>Fecha inicio</th>
          <th>Fecha finalización</th>
        </tr>
      </thead>

      <tbody>
        ${current.rows
          .map(
            (row) => `
              <tr>
                <td>${row.orden}</td>
                <td>${row.tarea}</td>
                <td>${row.fecha_inicio}</td>
                <td>${row.fecha_fin || "Pendiente"}</td>
              </tr>
            `
          )
          .join("")}
      </tbody>
    </table>
  `;

  const response = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Migracion Monitor <onboarding@resend.dev>",
        to: [notificationEmail],
        subject,
        html,
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();

    throw new Error(
      `Resend failed: ${response.status} ${error}`
    );
  }

  console.log("Email notification sent.");
}

async function main() {
  if (!passport || !caseNumber) {
    throw new Error(
      "MIGRACION_PASSPORT or MIGRACION_CASE is missing."
    );
  }

  if (!resendApiKey || !notificationEmail) {
    throw new Error(
      "RESEND_API_KEY or NOTIFICATION_EMAIL is missing."
    );
  }

  console.log("Checking migration status...");

  const html = await getStatus();

  console.log(
    `Received ${html.length} characters from Migracion.`
  );

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

  const result = findChanges(previous, current);

  if (result.changed) {
    console.log("Change detected.");
    await sendEmail(current, result.changes);
  } else {
    console.log("No changes detected.");
  }

  fs.mkdirSync(
    path.dirname(statusPath),
    { recursive: true }
  );

  fs.writeFileSync(
    statusPath,
    JSON.stringify(current, null, 2) + "\n"
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
