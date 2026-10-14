// The widgets the app offers (step 6e): the agenda and the discussions.

import SwiftUI
import WidgetKit

@main
struct RuchoirWidgets: WidgetBundle {
  var body: some Widget {
    AgendaWidget()
    DiscussionsWidget()
  }
}
