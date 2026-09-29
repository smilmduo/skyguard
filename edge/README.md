# SkyGuard AI — Edge Tier (ESP32 / TinyML)

This directory contains the edge-deployable artifacts for Automatic Weather Station (AWS) field microcontrollers.

## Artifacts

1. **`skyguard_model.h`**
   - Transpiled zero-dependency C++ header containing the ensemble decision trees.
   - Compiled with `PROGMEM` attributes for `.rodata` flash storage ($\le 298.7\text{ KB}$ Flash footprint, capped to 115 trees).
   - Consumes 0 bytes of dynamic heap/SRAM, leaving standard ESP32 RAM free for networking.
   - Sub-15ms inference latency per observation step.

2. **`esp32_firmware.ino`**
   - Arduino / ESP-IDF sketch with non-blocking ring buffer, I2C sensor driver interfaces (BME280 / SHT31 / Setra), and dual-threshold state machine.
   - Evaluates physical wet-bulb invariants, sensor freeze/stagnation flatlines, and spatial delta gates directly at the field node.

## Compilation & Flashing Instructions

1. Open Arduino IDE or PlatformIO.
2. Select Board: `ESP32 Dev Module` (or `ESP32-S3`).
3. Set Partition Scheme: `Default 4MB with spiffs (1.2MB APP / 1.5MB SPIFFS)` or `No OTA (2MB APP / 2MB SPIFFS)`.
4. Include `skyguard_model.h` in the sketch folder.
5. Connect ESP32 via USB and click **Upload**.
