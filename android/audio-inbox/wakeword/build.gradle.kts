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

// A measurement, not a test: it needs a corpus of audio that is too large and too borrowed to commit.
// ./gradlew :wakeword:wakeCorpusReport -Pcorpus=<dir of 16 kHz mono WAVs> [-Ptraces=<dir>] [-Pphrases=hey-jarvis]
tasks.register<JavaExec>("wakeCorpusReport") {
    group = "verification"
    description = "Counts how often each wake phrase fires on audio that contains no wake word."
    mainClass.set("io.agentmux.wakeword.WakeCorpusReportKt")
    classpath = sourceSets["test"].runtimeClasspath
    workingDir = projectDir
    argumentProviders.add {
        val corpus = providers.gradleProperty("corpus").orNull
            ?: error("pass -Pcorpus=<directory of 16 kHz mono WAVs>")
        listOfNotNull(
            "corpus=$corpus",
            providers.gradleProperty("traces").orNull?.let { "traces=$it" },
            providers.gradleProperty("phrases").orNull?.let { "phrases=$it" },
        )
    }
}
