import { useEffect, useState, useCallback } from 'react'
import { useSubscription } from 'mqtt-react-hooks'

import BeaconMap from './BeaconMap'
import Environment from '../environment.config'

import { ISettings, DefaultSettings } from './settings/SettingsModal'
import { getCurrentTimestamp } from '../utils/timestamp'
import { processRawMessage, recalculate } from '../utils/messageProcessing'
import { validateMqttMessage } from '../utils/validation'

import { getDatabase, ref, push, set, onValue, query, orderByChild, startAt } from 'firebase/database'
import { initializeApp } from 'firebase/app'

interface MqttBridgePublish {
  beaconMac: string
  bridgeCoordinates: number[]
  bridgeName: string
  rssi: number
  timestamp: number
  pdu?: number
}

export interface PublishedDevice extends MqttBridgePublish {
  seenTimestamp: number
  timedOut?: boolean
}

export interface DBEntry {
  ts: number
  beaconMac: string
  rssi: number
  bridgeLat: number
  bridgeLng: number
  bridgeName: string
  pdu: number
}

export type PublishedDeviceUpdater = (devices: PublishedDevice[]) => void
export type DetectedBridgeUpdater = (bridges: DetectedBridge[]) => void

export interface DetectedBridge {
  coordinates: number[]
  bridgeName: string // this must be unique for each detected bridge
  beacons?: Beacon[]
}

export interface Beacon {
  beaconMac: string
  timestamp: number
  coordinates: number[]
}

// this component is a wrapper for the entire app which handles new mqtt message
// logic, querying the database, and keeping track of local state (message
// processing dependent on settings)
export default function MqttListener() {
  const [bridges, setBridges] = useState<DetectedBridge[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [previousMessage, setPreviousMessage] = useState<string>("")
  const [publishedDevices, setPublishedDevices] = useState<PublishedDevice[]>([])
  const [settings, setSettings] = useState<ISettings>(DefaultSettings)
  const [startupQuery, setStartupQuery] = useState<boolean>(true)
  const { message } = useSubscription(Environment().mqttTopic);

  const firebaseConfig = {
    apiKey: Environment().firebaseApiKey,
    authDomain: Environment().firebaseAuthDomain,
    databaseURL: Environment().firebaseUrl,
    projectId: "beacon-locator-bf22b",
    storageBucket: "beacon-locator-bf22b.appspot.com",
    messagingSenderId: "457643290964",
    appId: "1:457643290964:web:2c8f57af3fd55b4a3b18c1",
    measurementId: "G-TW71FFP3RH"
  }
  const app = initializeApp(firebaseConfig)
  const fireDB = getDatabase(app)

  const fetchRecords = useCallback(async (since: number) => {
    setLoading(true)
    let records: Record<string, any>[] = []

    const mqttMessageListRef = query(ref(fireDB, 'RAW MQTT'), orderByChild('ts'), startAt(since.toString()))
    onValue(mqttMessageListRef, (snapshot: any) => {
      snapshot.forEach((childSnapshot: any) => {
        const childData = childSnapshot.val();
        records.push(childData)
      })
      recalculate(records, settings, setBridges, setPublishedDevices)
      setLoading(false)
    }, {
      onlyOnce: true
    })

  }, [fireDB, settings])

  const insertToDb = useCallback(async (message: PublishedDevice) => {
    const dbEntry: DBEntry = {
      bridgeLat: message.bridgeCoordinates[0],
      bridgeLng: message.bridgeCoordinates[1],
      ts: message.timestamp,
      bridgeName: message.bridgeName,
      beaconMac: message.beaconMac,
      rssi: message.rssi,
      pdu: 0,
    }

    try {
      const mqttMessageListRef = ref(fireDB, 'RAW MQTT')
      const newMqttMessageRef = push(mqttMessageListRef)
      set(newMqttMessageRef, dbEntry)
    } catch (e) {
      // TODO: implement logging
      console.warn(e)
    }
  }, [fireDB])

  // logic for recalculating based on new data from database
  useEffect(() => {
    if (settings === DefaultSettings) return

    fetchRecords(settings.sinceTime)
  }, [settings, fetchRecords])

  // first database query upon client connection. Pulls last hour of info
  useEffect(() => {
    if (startupQuery) {
      // fetchRecords from last hour '-1'
      fetchRecords(getCurrentTimestamp(-1))
      setStartupQuery(false)
    }
  }, [settings, fetchRecords, startupQuery])

  // logic for incomming messages:
  // Put each message into the database, then process it with (processRawMessage's)
  // logic. If settings are changed or old data needs to be pulled down from
  // the database, local state needs to be cleared and all messages must be
  // processed again.
  useEffect(() => {
    // reject bad messages, or the if the component just refreshed, don't do anything
    if (!message?.message || typeof message.message != "string" ||
      message.message === previousMessage
    ) {
      return
    }
    setPreviousMessage(message.message)

    const receivedMessage: PublishedDevice | undefined =
      validateMqttMessage(message.message)
    if (!receivedMessage) return

    insertToDb(receivedMessage)

    processRawMessage(
      publishedDevices, receivedMessage, settings,
      setBridges, setPublishedDevices
    )
  }, [message, insertToDb, previousMessage, publishedDevices, settings])

  return (
    <BeaconMap
      //@ts-ignore
      loading={loading}
      detectedBridges={bridges}
      setSettings={setSettings}
    />
  )
}
