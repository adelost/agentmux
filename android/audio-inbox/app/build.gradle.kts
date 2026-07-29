plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val linkReleaseStore = providers.environmentVariable("AGENTMUX_LINK_RELEASE_STORE")
    .orElse("/home/adelost/.agentmux/secrets/agentmux-link-release.p12")
    .get()

android {
    namespace = "io.agentmux.audioinbox"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.agentmux.audioinbox"
        minSdk = 26
        targetSdk = 35
        versionCode = 3
        versionName = "1.1.1"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField(
            "String",
            "UPDATE_SIGNER_SHA256",
            "\"B57A2862AB312BC970BEEEFC" +
                "D55D4B48A974EFD85B274B91394D4C9199484E97\"",
        )
    }

    signingConfigs {
        if (file(linkReleaseStore).isFile) {
            create("linkRelease") {
                storeFile = file(linkReleaseStore)
                storePassword = ""
                keyAlias = "agentmux-link"
                keyPassword = ""
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("linkRelease")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation(project(":link-core"))
    implementation("io.v1d.circlekit:designkit:0.2.1")
    implementation("io.v1d.circlekit:ringkit:0.2.1")
    implementation("io.v1d.circlekit:releasekit:0.2.1")
    implementation("io.v1d.circlekit:servicekit:0.2.1")
    implementation("androidx.annotation:annotation:1.9.1")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.media3:media3-exoplayer:1.6.1")
    implementation("androidx.media3:media3-session:1.6.1")
    implementation("net.i2p.crypto:eddsa:0.3.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
