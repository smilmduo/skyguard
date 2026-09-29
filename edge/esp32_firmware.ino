/*
 * SkyGuard AI — ESP32 Firmware Sketch (SIH PS 26073)
 * Implements Edge-First 18-Feature Isolation Forest Anomaly Detection
 * Zero dynamic allocations, constant O(1) memory, PROGMEM model footprint <= 300 KB.
 */

#include <Wire.h>
#include "skyguard_model.h"

// I2C Sensor Addresses (BME280 / SHT31)
#define BME280_ADDRESS 0x76
#define SHT31_ADDRESS 0x44

#define INFERENCE_INTERVAL_MS 3600000 // 1 Hour (Standard AWS interval)

// Global State
EdgeExtractorState extractor;
DualThresholdState decision_state;
unsigned long last_inference = 0;
int current_hour = 12;

// Telemetry Mesh Struct (Simulated LoRa / ESP-NOW / MQTT from neighboring AWS stations)
struct RegionalTelemetry {
    bool valid;
    unsigned long timestamp;
    float temp;
    float pres;
    float rh;
};

RegionalTelemetry latest_neighbor;

// Sensor Read Stubs (Replace with real Adafruit_BME280 / SHT31 drivers)
float read_temp() { return 35.2f; }
float read_pres() { return 1005.1f; }
float read_rh()   { return 59.5f; }

void setup() {
    Serial.begin(115200);
    Wire.begin();
    
    // Initialize state machines
    init_edge_extractor(&extractor);
    init_dual_threshold(&decision_state);
    
    // Initial simulated neighbor mesh packet
    latest_neighbor.valid = true;
    latest_neighbor.timestamp = millis();
    latest_neighbor.temp = 35.0f;
    latest_neighbor.pres = 1005.0f;
    latest_neighbor.rh = 60.0f;
    
    Serial.println("==================================================");
    Serial.println("SkyGuard AI — ESP32 Meteorological Edge Node");
    Serial.println("Model: 18-Feature Single Isolation Forest (PROGMEM)");
    Serial.printf("Ensemble Size: %d trees | Flash: ~295 KB\n", NUM_TREES);
    Serial.println("==================================================");
}

void run_inference() {
    unsigned long start_time = millis();
    
    // 1. Read Sensors
    float t_curr = read_temp();
    float p_curr = read_pres();
    float rh_curr = read_rh();
    
    // Check neighbor freshness (Roadmap Section 13: age <= 3600s)
    bool n_valid = latest_neighbor.valid && ((millis() - latest_neighbor.timestamp) <= 3600000);
    
    // 2. Extract 18 Features Streaming
    float features[NUM_FEATURES];
    bool is_ready = extract_features_streaming(
        &extractor,
        current_hour,
        t_curr, p_curr, rh_curr,
        n_valid,
        latest_neighbor.temp, latest_neighbor.pres, latest_neighbor.rh,
        features
    );
    
    // Increment hour
    current_hour = (current_hour + 1) % 24;
    
    // Warm-up guard (Roadmap Section 8: Suppress inference for first 12 samples)
    if (!is_ready) {
        Serial.printf("[WARM-UP] Step %d/12. Updating EWMA baselines and kinematic state...\n", extractor.warmup_counter);
        return;
    }
    
    // 3. Evaluate Single Isolation Forest (Roadmap Section 3.1 & 20)
    float anomaly_score = compute_if_anomaly_score(features);
    
    // 4. Evaluate Dual-Threshold Decision Layer (Roadmap Section 21-25)
    float rh_overshoot = features[FEAT_RH_OVERSHOOT];
    float max_flatline = fmaxf(features[FEAT_TEMP_FLATLINE], 
                               fmaxf(features[FEAT_PRES_FLATLINE], features[FEAT_RH_FLATLINE]));
                               
    int alert_code = process_decision_reading(&decision_state, anomaly_score, rh_overshoot, max_flatline, n_valid);
    unsigned long latency = millis() - start_time;
    
    // 5. Log & Uplink
    Serial.printf("[INFERENCE] Score: %.4f (T_mod=%.4f, T_ext=%.4f) | Latency: %lu ms\n", 
                  anomaly_score, T_MODERATE, T_EXTREME, latency);
                  
    if (alert_code == 1) {
        Serial.println(">>> [ALERT: IMMEDIATE EXTREME] Very high IF score detected!");
        // LoRa/ESP-NOW emergency transmit
    } else if (alert_code == 2) {
        Serial.println(">>> [ALERT: IMMEDIATE PHYSICAL] Wet-bulb overshoot or severe flatline detected!");
    } else if (alert_code == 3) {
        Serial.printf(">>> [ALERT: PERSISTENT CONFIRMED] Persistent anomaly detected over %d steps!\n", PERSISTENCE_K);
    } else {
        if (decision_state.suspected_counter > 0) {
            Serial.printf("[STATUS: SUSPECTED] Accumulating: %d/%d steps.\n", decision_state.suspected_counter, PERSISTENCE_K);
        } else {
            Serial.println("[STATUS: NORMAL] Telemetry consistent with regional baseline.");
        }
    }
}

void loop() {
    if (millis() - last_inference >= INFERENCE_INTERVAL_MS) {
        last_inference = millis();
        run_inference();
    }
}
