plugins {
    id("org.jetbrains.kotlin.jvm")
}

kotlin {
    jvmToolchain(17)
}

// The Android host supplies onnxruntime-android; JVM tests run the same Java API on the desktop runtime.
val onnxRuntimeVersion = "1.29.0"

dependencies {
    compileOnly("com.microsoft.onnxruntime:onnxruntime:$onnxRuntimeVersion")
    testImplementation("com.microsoft.onnxruntime:onnxruntime:$onnxRuntimeVersion")
    testImplementation("junit:junit:4.13.2")
}
