plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val linkReleaseStore = providers.gradleProperty("agentmuxLinkReleaseStore")
    .orElse(providers.environmentVariable("AGENTMUX_LINK_RELEASE_STORE"))
    .orNull
val linkReleaseStorePassword = providers.gradleProperty("agentmuxLinkReleaseStorePassword")
    .orElse(providers.environmentVariable("AGENTMUX_LINK_RELEASE_STORE_PASSWORD"))
    .orNull
val linkReleaseKeyPassword = providers.gradleProperty("agentmuxLinkReleaseKeyPassword")
    .orElse(providers.environmentVariable("AGENTMUX_LINK_RELEASE_KEY_PASSWORD"))
    .orNull
val linkReleaseKeyAlias = providers.gradleProperty("agentmuxLinkReleaseKeyAlias")
    .orElse(providers.environmentVariable("AGENTMUX_LINK_RELEASE_KEY_ALIAS"))
    .getOrElse("agentmux-link")

android {
    namespace = "io.agentmux.audioinbox"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.agentmux.audioinbox"
        minSdk = 26
        targetSdk = 35
        versionCode = 6
        versionName = "1.1.4"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (
            linkReleaseStore != null &&
            linkReleaseStorePassword != null &&
            linkReleaseKeyPassword != null &&
            file(linkReleaseStore).isFile
        ) {
            create("linkRelease") {
                storeFile = file(linkReleaseStore)
                storePassword = linkReleaseStorePassword
                keyAlias = linkReleaseKeyAlias
                keyPassword = linkReleaseKeyPassword
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
    implementation(project(":link-session-android"))
    implementation(project(":link-transport"))
    implementation(project(":link-update-android"))
    implementation("com.google.android.gms:play-services-wearable:20.0.1")
    implementation("io.v1d.circlekit:designkit:0.3.3")
    implementation("io.v1d.circlekit:ringkit:0.3.3")
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
    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
