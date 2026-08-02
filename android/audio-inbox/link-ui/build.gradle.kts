plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val circleKitVersion = providers.gradleProperty("circlekitVersion").get()

android {
    namespace = "io.agentmux.linkui"
    compileSdk = 35

    defaultConfig { minSdk = 26 }
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
    implementation("io.v1d.circlekit:designkit:$circleKitVersion")
    implementation("io.v1d.circlekit:ringkit:$circleKitVersion")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.foundation:foundation")
    testImplementation("junit:junit:4.13.2")
}
