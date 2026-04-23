const mqtt = require("mqtt")
const { Client } = require("pg")

// 🔹 MQTT (está en la misma EC2 pública)

const mqttClient = mqtt.connect("mqtt://localhost:1883")

// 🔹 PostgreSQL (EC2 privada)
const pgClient = new Client({
  host: "172.31.61.94",   // IP privada
  user: "postgres",
  password: "1234",       // el que seteaste
  database: "objects_db",
  port: 5432,
})

async function start() {
  try{
  await pgClient.connect()
  console.log("Conectado a PostgreSQL")
  console.log("mqtt client")

  mqttClient.on("connect", () => {
    console.log("Conectado a MQTT")
    mqttClient.subscribe("factory/height")
  })
} catch (err){
  console.error('Error: ', err)
}

  mqttClient.on("message", async (topic, message) => {
    try {
      const data = JSON.parse(message.toString())

      const { objectId, measuredHeight } = data

      console.log("Recibido:", data)

      // 🔍 Buscar altura esperada
      const res = await pgClient.query(
        `SELECT h.height
         FROM measure_h mh
         JOIN height h ON mh.id_h = h.id_h
         WHERE mh.id_obj = $1`,
        [objectId]
      )

      if (res.rows.length === 0) {
        console.log("Objeto no encontrado")
        return
      }

      const expected = res.rows[0].height

      // 🎯 Tolerancia 15%
      const tolerance = expected * 0.15

      const isValid =
        Math.abs(measuredHeight - expected) <= tolerance

      const result = isValid ? "ACCEPT" : "REJECT"

      console.log("Resultado:", result)

      // 📡 Publicar respuesta
      mqttClient.publish(
        "factory/result",
        JSON.stringify({ objectId, result })
      )

    } catch (err) {
      console.error("Error:", err)
    }
  })
}

start()
