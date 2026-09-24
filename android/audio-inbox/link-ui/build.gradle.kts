plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val circleKitVersion = providers.gradleProperty("circlekitVersion").get()

android {
    namespace = "io.agentmux.linkui"
    compileSdk = 35

    defaultConfig {
        minSdk = 26
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
    testOptions { unitTests.isReturnDefaultValues = true }
}

dependencies {
    api(project(":link-core"))
    api(project(":wakeword"))
    implementation("io.v1d.circlekit:designkit:$circleKitVersion")
    implementation("io.v1d.circlekit:ringkit:$circleKitVersion")
    api("io.v1d.circlekit:releasekit-ui:$circleKitVersion")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.foundation:foundation")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation(platform("androidx.compose:compose-bom:2024.12.01"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test:runner:1.6.2")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}

// Studio gives each focused recording a new directory, so Gradle must rerun its named test.
tasks.withType<Test>().configureEach {
    inputs.property("studioTraceDir", providers.environmentVariable("V1D_STUDIO_TRACE_DIR").orElse(""))
}
