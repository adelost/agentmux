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

// Measurements, not tests: they need audio that is too large and too borrowed to commit.
// ./gradlew :wakeword:wakeCorpusReport   -Pcorpus=<dir built by scripts/wake-corpus.sh>   [-Ptraces=<dir>] [-Pphrases=..] [-Pdetection=1,2,3] [-Pthreshold=0.78]
// ./gradlew :wakeword:wakePositivesReport -Pclips=<dir built by scripts/wake-positives.sh> [-Pphrases=..] [-Pdetection=1,2,3] [-Pthreshold=0.5]
fun Project.measurement(name: String, mainClass: String, required: String, optional: List<String>) =
    tasks.register<JavaExec>(name) {
        group = "verification"
        description = "Measures the wake word against audio built by scripts/, never against a fixture."
        this.mainClass.set(mainClass)
        classpath = sourceSets["test"].runtimeClasspath
        workingDir = projectDir
        argumentProviders.add {
            val value = providers.gradleProperty(required).orNull
                ?: error("pass -P$required=<directory>")
            listOf("$required=$value") +
                optional.mapNotNull { key -> providers.gradleProperty(key).orNull?.let { "$key=$it" } }
        }
    }

measurement(
    "wakeCorpusReport", "io.agentmux.wakeword.WakeCorpusReportKt",
    required = "corpus", optional = listOf("traces", "phrases", "detection", "threshold"),
)
measurement(
    "wakePositivesReport", "io.agentmux.wakeword.WakePositivesReportKt",
    required = "clips", optional = listOf("phrases", "detection", "threshold"),
)
