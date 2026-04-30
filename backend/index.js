const mqtt = require("mqtt")
const { Client } = require("pg")
const { MongoClient } = require("mongodb")
require("dotenv").config()

// 🔹 MQTT (está en la misma EC2 pública)

const mqttClient = mqtt.connect("mqtt://localhost:1883")
mqttClient.on("connect", () => {
  console.log("✅ MQTT conectado")
  mqttClient.subscribe("factory/height")
})

mqttClient.on("offline", () => {
  console.log("⚠️ MQTT offline")
})

mqttClient.on("error", (err) => {
  console.error("❌ MQTT error:", err)
})

const mongoClient = new MongoClient("mongodb://" + process.env.PG_HOST + ":27017")
let logsCollection

// 🔹 PostgreSQL (EC2 privada)
const pgClient = new Client({
  host: process.env.PG_HOST,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DB,
  port: 5432,
})

async function start() {
  try {
    await mongoClient.connect()
    const db = mongoClient.db("logsDB")
    logsCollection = db.collection("logs")
    console.log("✅ Conectado a MongoDB")

    await pgClient.connect()
    console.log("✅ Conectado a PostgreSQL")
  }
    catch (err) {
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

      await logsCollection.insertOne({
        objectId,
        measuredHeight,
        expectedHeight: expected,
        result,
        timestamp: new Date()
      })

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
