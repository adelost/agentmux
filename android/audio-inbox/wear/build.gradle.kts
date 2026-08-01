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
    namespace = "io.agentmux.audioinbox.wear"
    compileSdk = 35

    defaultConfig {
        // Data Layer peers must share application id and signing identity.
        applicationId = "io.agentmux.audioinbox"
        minSdk = 30
        targetSdk = 35
        versionCode = 5
        versionName = "0.1.4"
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
            isMinifyEnabled = true
            isShrinkResources = true
            signingConfig = signingConfigs.findByName("linkRelease")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation(project(":link-core"))
    implementation(project(":link-session-android"))
    implementation(project(":link-transport"))
    implementation(project(":link-ui"))
    implementation(project(":link-update-android"))
    implementation("com.google.android.gms:play-services-wearable:20.0.1")
    implementation("io.v1d.circlekit:ringkit:0.3.7")
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    testImplementation("junit:junit:4.13.2")
}
