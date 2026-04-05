import XCTest

@MainActor
class ScreenshotTests: XCTestCase {
    let app = XCUIApplication()

    override func setUp() {
        continueAfterFailure = false
        setupSnapshot(app)
        app.launch()
    }

    func testScreenshots() {
        sleep(3)
        snapshot("01_Home")

        app.tabBars.buttons["My Library"].tap()
        sleep(1)
        snapshot("02_Library")

        app.tabBars.buttons["Queue"].tap()
        sleep(1)
        snapshot("03_Queue")

        app.tabBars.buttons["Settings"].tap()
        sleep(1)
        snapshot("04_Settings")

        app.tabBars.buttons["Home"].tap()
        sleep(1)
        snapshot("05_HomeMain")
    }
}
