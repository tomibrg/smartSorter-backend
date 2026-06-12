const mqtt = require("mqtt")
const { Client } = require("pg")
const express = require("express")
const http = require("http")
const WebSocket = require("ws")
// const { MongoClient } = require("mongodb")
require("dotenv").config()

// 🔹 Express + HTTP + WebSocket
const app = express()
const server = http.createServer(app)
const wss = new WebSocket.Server({ server })

// Servir archivos estáticos (la página HTML)
app.use(express.static("public"))

// 🔹 API - Historial desde PostgreSQL
app.get("/api/history", async (req, res) => {
  try {
    const result = await pgClient.query(`
      SELECT r.primary_resut_id, r.id_obj, r.id_res, r.id_mot,
             res.result AS result_name,
             m.motive AS motive_name,
             o.name AS object_name
      FROM results r
      LEFT JOIN result res ON r.id_res = res.id_res
      LEFT JOIN motive m ON r.id_mot = m.id_mot
      LEFT JOIN object o ON r.id_obj = o.id_obj
      ORDER BY r.primary_resut_id DESC
      LIMIT 200
    `)
    res.json(result.rows)
  } catch (err) {
    console.error("Error fetching history:", err)
    res.status(500).json({ error: "Error al obtener historial" })
  }
})

// 🔹 MQTT (está en la misma EC2 pública)
const stringPghost = process.env.PG_HOST;

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

// 🔹 WebSocket - Manejar conexiones del front
wss.on("connection", (ws) => {
  console.log("✅ Cliente web conectado")
  
  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message)
      
      if (data.type === "decision") {
        console.log("📨 Decisión recibida del operador:", data)

        await wrtieLogInDB(data.product_id, (data.decision === "accepted"? 1: 2),(data.measuredHeight < 0? 1: 2))
        
        // Confirmar al frontend que se guardó
        ws.send(JSON.stringify({
          type: "decision_saved",
          product_id: data.product_id,
          decision: data.decision
        }))

        // 📡 Enviar resultado al ESP vía MQTT
        const mqttMessage = {
          objectId: data.product_id,
          result: data.decision === "accepted" ? "ACCEPT" : "REJECT"
        }
        
        mqttClient.publish("factory/result", JSON.stringify(mqttMessage))
        console.log("📤 Enviado al ESP:", mqttMessage)
      }
    } catch (err) {
      console.error("Error en WebSocket:", err)
    }
  })
  
  ws.on("close", () => {
    console.log("⚠️ Cliente web desconectado")
  })
})

// const mongoClient = new MongoClient("mongodb://" + stringPghost + ":27017")
// let logsCollection

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
    // await mongoClient.connect()
    // const db = mongoClient.db("logsDB")
    // logsCollection = db.collection("logs")
    // console.log("✅ Conectado a MongoDB")

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
        mqttClient.publish(
    "factory/result",
    JSON.stringify({ objectId, result: "REJECT" })
  )
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: "product_rejection",
        product_id: objectId,
        height_error: 0,
        measured: 0,
        expected: 0,
        reason: "Objeto no encontrado en base de datos"
          }))
        }
      })
      return 
    }

      const expected = res.rows[0].height

      // 🎯 Tolerancia 15%
      const tolerance = expected * 0.15

      const isValid =
        Math.abs(measuredHeight - expected) <= tolerance

      const result = isValid ? "ACCEPT" : "REJECT"



      console.log("Resultado:", result)

      // await logsCollection.insertOne({
      //   objectId,
      //   measuredHeight,
      //   expectedHeight: expected,
      //   result,
      //   timestamp: new Date()
      // })

      // ❌ Si es RECHAZO, notificar al operador en el front
      if (result === "REJECT") {
        const heightError = measuredHeight - expected
        
        console.log("⚠️ Producto rechazado - Notificando al operador")
        
        // Enviar a todos los clientes WebSocket conectados
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: "product_rejection",
              product_id: objectId,
              height_error: heightError,
              measured: measuredHeight,
              expected: expected
            }))
          }
        })
      } else {
        // ✅ Si es aceptado automáticamente, publicar al ESP directamente
        await wrtieLogInDB(objectId, 1, 3)

        // Notificar al frontend
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: "product_accepted",
              product_id: objectId
            }))
          }
        })

        mqttClient.publish(
          "factory/result",
          JSON.stringify({ objectId, result })
        )
      }

    } catch (err) {
      console.error("Error:", err)
    }
  })
}

start()

// 🔹 Iniciar servidor en puerto 8000
const PORT = process.env.PORT || 8000
server.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`)
})


async function wrtieLogInDB(objectId, resultId, motiveId) {
  await pgClient.query(`INSERT INTO results (id_obj, id_res, id_mot) VALUES ($1, $2, $3)`, 
    [objectId, resultId, motiveId])

    console.log(`Log guardado: el objeto resulto ${objectId, resultId, motiveId}`)
}