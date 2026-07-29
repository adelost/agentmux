pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // CircleKit: the shared adaptive UI and update engine, consumed as
        // pinned immutable artifacts. CIRCLEKIT_MAVEN_URL may point a working
        // copy at a local publication; the committed default resolves without
        // one, so no sibling checkout is ever required.
        maven {
            name = "circlekit"
            url = uri(
                providers.gradleProperty("circlekitMavenUrl")
                    .orElse(providers.environmentVariable("CIRCLEKIT_MAVEN_URL"))
                    .getOrElse("https://circlekit.pages.dev/"),
            )
            content { includeGroup("io.v1d.circlekit") }
        }
    }
}

rootProject.name = "Agent Audio Inbox"
include(":app", ":link-core", ":link-session-android", ":link-transport", ":wear")
